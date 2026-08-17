import { sql, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import type { Tx } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import { branches } from "@/server/branches/schema";
import type { UnitOfMeasure } from "@/server/catalog/uom";
import { assertInventoryUom, qty } from "@/server/inventory/uom";
import { money } from "@/server/ordering/service";
import { purchaseOrders, purchaseOrderLines, suppliers } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { InvalidPoInputError, InvalidPoTransitionError, PoNotFoundError } from "./errors";
import { assertTransition } from "./status";
import { lockTenant } from "./locking";
import type { PoStatus } from "./status";

function auditCtx(actor: PurchasingActor) {
  return {
    tenantId: actor.tenantId,
    branchId: actor.branchId,
    actorUserId: actor.actorUserId,
    fingerprint: emptyFingerprint(),
  };
}

export type DraftPoLineInput = {
  itemId: string;
  qtyOrdered: number;
  uom: UnitOfMeasure;
  unitCost: number;
  taxRate?: number;
};

export type DraftPoInput = {
  supplierId: string;
  branchId: string;
  expectedAt?: Date | null;
  lines: DraftPoLineInput[];
};

/**
 * The header total is TAX-INCLUSIVE, because `invoiceTotal` — the figure the
 * supplier actually bills — is. Summing lines tax-exclusive made
 * `invoiceVsReceived` report a variance on every tax-bearing PO, which buries
 * real discrepancies in structural noise and defeats the three-way match.
 */
function lineTotal(lines: DraftPoLineInput[]): number {
  return lines.reduce((s, l) => s + l.qtyOrdered * l.unitCost * (1 + (l.taxRate ?? 0)), 0);
}

/**
 * The routes parse and validate their own bodies, but these are exported
 * service functions — the cron, scripts and tests all reach them directly, so
 * the numeric floor has to live here too rather than only at the HTTP edge.
 */
function assertLineNumbers(lines: DraftPoLineInput[]): void {
  if (lines.length === 0) throw new InvalidPoInputError("a purchase order needs at least one line");
  for (const l of lines) {
    if (!l.itemId) throw new InvalidPoInputError("each line needs an itemId");
    if (!Number.isFinite(l.qtyOrdered) || l.qtyOrdered <= 0) {
      throw new InvalidPoInputError(`qtyOrdered must be a positive finite number (got ${l.qtyOrdered})`);
    }
    if (!Number.isFinite(l.unitCost) || l.unitCost < 0) {
      throw new InvalidPoInputError(`unitCost must be a finite non-negative number (got ${l.unitCost})`);
    }
    if (l.taxRate !== undefined && (!Number.isFinite(l.taxRate) || l.taxRate < 0)) {
      throw new InvalidPoInputError(`taxRate must be a finite non-negative number (got ${l.taxRate})`);
    }
  }
}

export async function createDraftPo(actor: PurchasingActor, input: DraftPoInput): Promise<{ poId: string; poNumber: number }> {
  requireCapability(actor.vertical, "inventory");
  assertLineNumbers(input.lines);
  return withTenant(actor.tenantId, async (tx) => {
    // Same per-tenant serialization discipline as placeOrder: the advisory lock
    // spans only the read-max-then-insert window, and FORCE RLS scopes the MAX
    // to this tenant via app.tenant_id.
    await lockTenant(tx, actor.tenantId);

    // RLS doesn't cover FK referential-integrity checks (Postgres runs those
    // with row security bypassed), so a body-supplied branch/supplier id could
    // point at another tenant's row. A SELECT under our RLS is itself the tenant
    // check: absent here means "not this tenant's" and the PO must not exist.
    const [branch] = await tx.select().from(branches).where(eq(branches.id, input.branchId));
    if (!branch) throw new InvalidPoInputError(`branchId ${input.branchId} is not a branch of this tenant`);
    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId));
    if (!supplier) throw new InvalidPoInputError(`supplierId ${input.supplierId} is not a supplier of this tenant`);

    const [{ max }] = await tx.select({ max: sql<number>`COALESCE(MAX(${purchaseOrders.poNumber}), 0)` }).from(purchaseOrders);
    const poNumber = Number(max) + 1;

    const total = money(lineTotal(input.lines));

    const [po] = await tx.insert(purchaseOrders).values({
      tenantId: actor.tenantId,
      branchId: input.branchId,
      supplierId: input.supplierId,
      poNumber,
      status: "draft",
      total,
      expectedAt: input.expectedAt ?? null,
      createdByUserId: actor.actorUserId,
    }).returning({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber });

    for (const l of input.lines) {
      const uom = assertInventoryUom(l.uom);
      await tx.insert(purchaseOrderLines).values({
        tenantId: actor.tenantId,
        poId: po.id,
        itemId: l.itemId,
        qtyOrdered: qty(l.qtyOrdered),
        uom,
        unitCost: money(l.unitCost),
        taxRate: l.taxRate !== undefined ? String(l.taxRate) : null,
        qtyReceived: "0",
      });
    }

    await recordAuditEvent(auditCtx(actor), {
      action: "po.created",
      entityType: "purchase_order",
      entityId: po.id,
      summary: `PO #${po.poNumber} drafted`,
      metadata: { supplierId: input.supplierId, total, lineCount: input.lines.length },
    }, tx);

    return { poId: po.id, poNumber: po.poNumber };
  });
}

export async function getPurchaseOrder(tenantId: string, poId: string) {
  return withTenant(tenantId, async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    return po ?? null;
  });
}

export async function listPurchaseOrders(tenantId: string, opts: { status?: PoStatus } = {}) {
  return withTenant(tenantId, async (tx) => {
    const where = opts.status ? eq(purchaseOrders.status, opts.status) : undefined;
    const rows = where
      ? await tx.select().from(purchaseOrders).where(where).orderBy(sql`${purchaseOrders.createdAt} DESC`)
      : await tx.select().from(purchaseOrders).orderBy(sql`${purchaseOrders.createdAt} DESC`);
    return rows;
  });
}

/** Locks the PO header with FOR UPDATE so the read-check-write guard in every
 *  mutation is total: postReceipt already locks this row, and now every other
 *  writer (updateDraftPo, cancelPurchaseOrder, sendPurchaseOrder,
 *  enterInvoiceTotal, closePurchaseOrder) takes the same lock, so a concurrent
 *  send/receive/cancel serializes instead of walking straight past a stale read. */
async function loadPo(tx: Tx, poId: string) {
  const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for("update").limit(1);
  if (!po) throw new PoNotFoundError();
  return po;
}

export async function updateDraftPo(actor: PurchasingActor, poId: string, input: DraftPoInput): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  assertLineNumbers(input.lines);
  return withTenant(actor.tenantId, async (tx) => {
    await lockTenant(tx, actor.tenantId);
    const po = await loadPo(tx, poId);
    if (po.status !== "draft") throw new InvalidPoTransitionError(po.status as PoStatus, "draft");

    // Same tenant-ownership guard as createDraftPo: the body's branch/supplier
    // must resolve under our RLS or the draft would reference another tenant.
    const [branch] = await tx.select().from(branches).where(eq(branches.id, input.branchId));
    if (!branch) throw new InvalidPoInputError(`branchId ${input.branchId} is not a branch of this tenant`);
    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId));
    if (!supplier) throw new InvalidPoInputError(`supplierId ${input.supplierId} is not a supplier of this tenant`);

    const total = money(lineTotal(input.lines));

    await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
    for (const l of input.lines) {
      const uom = assertInventoryUom(l.uom);
      await tx.insert(purchaseOrderLines).values({
        tenantId: actor.tenantId,
        poId,
        itemId: l.itemId,
        qtyOrdered: qty(l.qtyOrdered),
        uom,
        unitCost: money(l.unitCost),
        taxRate: l.taxRate !== undefined ? String(l.taxRate) : null,
        qtyReceived: "0",
      });
    }
    await tx.update(purchaseOrders)
      .set({ total, supplierId: input.supplierId, branchId: input.branchId, expectedAt: input.expectedAt ?? null })
      .where(eq(purchaseOrders.id, poId));

    await recordAuditEvent(auditCtx(actor), {
      action: "po.updated",
      entityType: "purchase_order",
      entityId: poId,
      summary: `PO #${po.poNumber} updated`,
      metadata: { supplierId: input.supplierId, total, lineCount: input.lines.length },
    }, tx);
  });
}

export async function cancelPurchaseOrder(actor: PurchasingActor, poId: string): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    await lockTenant(tx, actor.tenantId);
    const po = await loadPo(tx, poId);
    assertTransition(po.status as PoStatus, "cancelled");
    await tx.update(purchaseOrders)
      .set({ status: "cancelled" })
      .where(eq(purchaseOrders.id, poId));

    await recordAuditEvent(auditCtx(actor), {
      action: "po.cancelled",
      entityType: "purchase_order",
      entityId: poId,
      summary: `PO #${po.poNumber} cancelled`,
      metadata: { fromStatus: po.status },
    }, tx);
  });
}
