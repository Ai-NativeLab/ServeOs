import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import { money } from "@/server/ordering/service";
import { purchaseOrders, purchaseOrderLines } from "./schema";
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

export type PoVariance = {
  total: string;
  receivedTotal: string;
  invoiceTotal: string | null;
  receivedVsOrdered: string;
  invoiceVsReceived: string | null;
  overReceived: boolean;
};

/** Three money figures per PO and their pairwise deltas (Spec 9 Part C). */
export async function getPoVariance(tenantId: string, poId: string): Promise<PoVariance> {
  return withTenant(tenantId, async (tx) => {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    if (!po) throw new PoNotFoundError();

    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
    const overReceived = lines.some((l) => Number(l.qtyReceived) > Number(l.qtyOrdered));

    // Received value is Σ receipt-line received_qty × unit_cost across every
    // receipt on this PO — the same aggregate the analytics report reads, so
    // the detail and the report can never disagree.
    const { rows: receivedRows } = await tx.execute<{ received: string }>(sql`
      SELECT COALESCE(SUM(prl.received_qty * prl.unit_cost), 0) AS received
      FROM po_receipt_lines prl
      JOIN po_receipts pr ON pr.id = prl.po_receipt_id
      WHERE pr.purchase_order_id = ${poId}
    `);

    const receivedTotal = money(Number(receivedRows[0]?.received ?? 0));
    const invoiceTotal = po.invoiceTotal ?? null;
    return {
      total: po.total,
      receivedTotal,
      invoiceTotal,
      receivedVsOrdered: money(Number(receivedTotal) - Number(po.total)),
      invoiceVsReceived: invoiceTotal === null ? null : money(Number(invoiceTotal) - Number(receivedTotal)),
      overReceived,
    };
  });
}

/** Records the supplier's actual invoice figure on the PO header (one number,
 *  never per-line — see the analytics-stub alignment in Task 5). Only POs that
 *  are at least `sent` can be invoiced: a draft has no commercial life and a
 *  terminal PO is already closed, so auditing a `po.invoiced` for either would
 *  be noise. */
export async function enterInvoiceTotal(actor: PurchasingActor, poId: string, invoiceTotal: number): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  if (!Number.isFinite(invoiceTotal) || invoiceTotal < 0) {
    throw new InvalidPoInputError(`invoiceTotal must be a non-negative finite number (got ${invoiceTotal})`);
  }
  return withTenant(actor.tenantId, async (tx) => {
    await lockTenant(tx, actor.tenantId);
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for("update").limit(1);
    if (!po) throw new PoNotFoundError();
    if (po.status !== "sent" && po.status !== "partially_received" && po.status !== "received") {
      throw new InvalidPoTransitionError(po.status as PoStatus, "received");
    }

    await tx.update(purchaseOrders)
      .set({ invoiceTotal: money(invoiceTotal) })
      .where(eq(purchaseOrders.id, poId));

    await recordAuditEvent(auditCtx(actor), {
      action: "po.invoiced",
      entityType: "purchase_order",
      entityId: poId,
      summary: `PO #${po.poNumber} invoiced at ${money(invoiceTotal)}`,
      metadata: { invoiceTotal: money(invoiceTotal), previous: po.invoiceTotal ?? null },
    }, tx);
  });
}

/** Closes a fully-received PO. Only `received → closed` is legal (terminals
 *  closed/cancelled have no outgoing edges). */
export async function closePurchaseOrder(actor: PurchasingActor, poId: string): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    await lockTenant(tx, actor.tenantId);
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).for("update").limit(1);
    if (!po) throw new PoNotFoundError();
    assertTransition(po.status, "closed");

    await tx.update(purchaseOrders)
      .set({ status: "closed" })
      .where(eq(purchaseOrders.id, poId));

    await recordAuditEvent(auditCtx(actor), {
      action: "po.closed",
      entityType: "purchase_order",
      entityId: poId,
      summary: `PO #${po.poNumber} closed`,
      metadata: { total: po.total },
    }, tx);
  });
}
