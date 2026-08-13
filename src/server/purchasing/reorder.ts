import { sql, eq, inArray, and } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import { qty } from "@/server/inventory/uom";
import { money } from "@/server/ordering/service";
import { notify } from "@/server/notifications/service";
import { inventoryItems } from "@/server/inventory/schema";
import { storageLocations } from "@/server/inventory/schema";
import { purchaseOrders, purchaseOrderLines, supplierItems, suppliers } from "./schema";
import { reorderRules } from "./reorder-schema";
import type { PurchasingActor } from "./suppliers";
import { InvalidPoInputError } from "./errors";

function auditCtx(actor: PurchasingActor) {
  return {
    tenantId: actor.tenantId,
    branchId: actor.branchId,
    actorUserId: actor.actorUserId,
    fingerprint: emptyFingerprint(),
  };
}

export type ReorderRuleInput = {
  itemId: string;
  locationId: string;
  reorderPoint: number;
  reorderQty: number;
  preferredSupplierId?: string | null;
};

export async function upsertReorderRule(actor: PurchasingActor, input: ReorderRuleInput): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    // Same per-tenant serialization as checkReorder: the advisory lock is the
    // FIRST statement every tenant writer takes. checkReorder holds it while it
    // reads-then-writes reorder_rules; acquiring it here at the start (instead
    // of letting recordAuditEvent grab it at the end) keeps both paths locking
    // in the same order — otherwise two writers of the same rule rows deadlock
    // (40P01). Re-acquiring in recordAuditEvent later is a re-entrant no-op.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${actor.tenantId})::bigint)`);

    // Body-supplied ids must resolve under our RLS or the rule could reference
    // another tenant's item/location/supplier (FK checks bypass row security).
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, input.itemId));
    if (!item) throw new InvalidPoInputError(`itemId ${input.itemId} is not an item of this tenant`);
    const [loc] = await tx.select().from(storageLocations).where(eq(storageLocations.id, input.locationId));
    if (!loc) throw new InvalidPoInputError(`locationId ${input.locationId} is not a location of this tenant`);
    if (input.preferredSupplierId) {
      const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, input.preferredSupplierId));
      if (!supplier) throw new InvalidPoInputError(`preferredSupplierId ${input.preferredSupplierId} is not a supplier of this tenant`);
    }

    await tx.insert(reorderRules).values({
      tenantId: actor.tenantId,
      itemId: input.itemId,
      locationId: input.locationId,
      reorderPoint: qty(input.reorderPoint),
      reorderQty: qty(input.reorderQty),
      preferredSupplierId: input.preferredSupplierId ?? null,
    }).onConflictDoUpdate({
      target: [reorderRules.itemId, reorderRules.locationId],
      set: {
        reorderPoint: qty(input.reorderPoint),
        reorderQty: qty(input.reorderQty),
        preferredSupplierId: input.preferredSupplierId ?? null,
      },
    });
    await recordAuditEvent(auditCtx(actor), {
      action: "reorder_rule.updated",
      entityType: "inventory_item",
      entityId: input.itemId,
      summary: `Reorder rule for item ${input.itemId} at location ${input.locationId} updated`,
      metadata: { itemId: input.itemId, locationId: input.locationId },
    }, tx);
  });
}

export async function listReorderRules(tenantId: string) {
  return withTenant(tenantId, async (tx) => tx.select().from(reorderRules));
}

export type ReorderRun = { triggered: number; draftsCreated: number };

/**
 * The Spec 9 reorder sweep. Runs on the caller's tx so the notifications and
 * the auto-drafted POs commit or roll back together.
 *
 *  - on-hand is the SUM of `inventory_lots.qty_remaining` per (item, location),
 *    the same shape getLowStock reads, so the report and the sweep agree.
 *  - "at or below" the point triggers, and a rule with no lots at all is low
 *    (on-hand 0) — the exact getLowStock semantics.
 *  - One `low_stock` event per triggered item (owner + manager, in_app + email).
 *  - Debounced by lastAlertedAt: a rule alerted in the last 24h is skipped.
 *  - Rules with a preferred supplier pre-fill one draft PO per supplier (never
 *    sent) at reorderQty × lastUnitCost (0 when the supplier has no price for it).
 *  - The sweep is serialized per tenant by the advisory lock taken as its FIRST
 *    statement: an overlapping run (or a cron re-fire) blocks until this one
 *    commits, then re-reads rules and lastAlertedAt, so it cannot double-notify
 *    or double-draft. A supplier with an already-open draft PO is skipped, so a
 *    chronically-low item cannot spawn a fresh draft every day forever.
 *  - Machine-written draft POs are audit-attributed by the caller: the cron
 *    passes an actor with actorType "system", an interactive check keeps the
 *    real user — the shared service never decides which it was.
 */
export async function checkReorder(actor: PurchasingActor): Promise<ReorderRun> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    // Serialize the whole sweep per tenant. Advisory locks are re-entrant, so
    // recordAuditEvent re-acquiring the same key later is a no-op; the sweep's
    // read-then-write steps (rules → debounce → notify → draft) are now atomic.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${actor.tenantId})::bigint)`);

    const rules = await tx.select().from(reorderRules).where(eq(reorderRules.isActive, true));
    if (rules.length === 0) return { triggered: 0, draftsCreated: 0 };

    const { rows } = await tx.execute<{ item_id: string; location_id: string; on_hand: string }>(sql`
      SELECT item_id, location_id, COALESCE(SUM(qty_remaining), 0) AS on_hand
      FROM inventory_lots
      GROUP BY item_id, location_id`);
    const onHand = new Map(rows.map((r) => [`${r.item_id}:${r.location_id}`, Number(r.on_hand)]));

    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const triggered: typeof rules = [];
    const actionable: typeof rules = [];
    for (const rule of rules) {
      if ((onHand.get(`${rule.itemId}:${rule.locationId}`) ?? 0) > Number(rule.reorderPoint)) continue;
      triggered.push(rule);
      const debounced = rule.lastAlertedAt !== null && now - rule.lastAlertedAt.getTime() < DAY_MS;
      if (!debounced) actionable.push(rule);
    }

    if (triggered.length === 0) return { triggered: 0, draftsCreated: 0 };

    const itemIds = [...new Set(triggered.map((r) => r.itemId))];
    const items = await tx.select().from(inventoryItems).where(inArray(inventoryItems.id, itemIds));
    const itemById = new Map(items.map((i) => [i.id, i]));

    for (const rule of actionable) {
      const item = itemById.get(rule.itemId);
      await notify({ tenantId: actor.tenantId }, {
        type: "low_stock",
        severity: "warning",
        title: `${item?.nameEn ?? "Item"} below reorder point`,
        body: `On hand at location ${rule.locationId} is ${onHand.get(`${rule.itemId}:${rule.locationId}`) ?? 0}, at or below the reorder point of ${Number(rule.reorderPoint)}.`,
        entityType: "inventory_item",
        entityId: rule.itemId,
        targets: [{ role: "owner" }, { role: "manager" }],
        channels: ["in_app", "email"],
        branchId: actor.branchId,
      }, tx);
      await tx.update(reorderRules)
        .set({ lastAlertedAt: new Date() })
        .where(eq(reorderRules.id, rule.id));
    }

    const bySupplier = new Map<string, typeof actionable>();
    for (const rule of actionable) {
      if (!rule.preferredSupplierId) continue;
      const list = bySupplier.get(rule.preferredSupplierId) ?? [];
      list.push(rule);
      bySupplier.set(rule.preferredSupplierId, list);
    }

    let draftsCreated = 0;
    for (const [supplierId, group] of bySupplier) {
      // The supplier id came from a reorder rule — verify it still resolves
      // under our RLS before drafting a PO against it (FK checks bypass RLS).
      const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, supplierId));
      if (!supplier) continue;

      // An open draft for this supplier+branch, if any. A chronically-low item
      // merges into it rather than stacking a fresh draft every cron run —
      // which means the merge must NOT silently drop a DIFFERENT low item that
      // triggered this run. Only items already lined on that draft are skipped;
      // every other triggered item is appended to it (or starts a fresh draft).
      const [open] = await tx.select({ id: purchaseOrders.id, total: purchaseOrders.total, poNumber: purchaseOrders.poNumber })
        .from(purchaseOrders)
        .where(and(
          eq(purchaseOrders.supplierId, supplierId),
          eq(purchaseOrders.branchId, actor.branchId),
          eq(purchaseOrders.status, "draft"),
        )).limit(1);

      // Items already covered by the open draft — the ones being merged — must
      // not be re-lined. The rest is what this run actually adds.
      const coveredItemIds = new Set<string>();
      if (open) {
        const covered = await tx.select({ itemId: purchaseOrderLines.itemId })
          .from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, open.id));
        for (const c of covered) coveredItemIds.add(c.itemId);
      }
      const pending = group.filter((r) => !coveredItemIds.has(r.itemId));
      if (pending.length === 0) continue;

      const groupItemIds = pending.map((r) => r.itemId);
      const priceRows = await tx.select().from(supplierItems)
        .where(and(inArray(supplierItems.itemId, groupItemIds), eq(supplierItems.supplierId, supplierId)));
      const costByItem = new Map(priceRows.map((s) => [s.itemId, Number(s.lastUnitCost ?? 0)]));

      let added = 0;
      const lines = pending.map((r) => {
        const cost = costByItem.get(r.itemId) ?? 0;
        added += Number(r.reorderQty) * cost;
        return { itemId: r.itemId, qtyOrdered: Number(r.reorderQty), uom: itemById.get(r.itemId)?.baseUom ?? "each", unitCost: cost };
      });

      if (open) {
        // Merge: append the missing lines to the existing draft and bump its total.
        const newTotal = Number(open.total ?? 0) + added;
        await tx.update(purchaseOrders)
          .set({ total: money(newTotal) })
          .where(eq(purchaseOrders.id, open.id));
        for (const l of lines) {
          await tx.insert(purchaseOrderLines).values({
            tenantId: actor.tenantId,
            poId: open.id,
            itemId: l.itemId,
            qtyOrdered: qty(l.qtyOrdered),
            uom: l.uom,
            unitCost: money(l.unitCost),
            qtyReceived: "0",
          });
        }
        await recordAuditEvent(auditCtx(actor), {
          action: "po.updated",
          entityType: "purchase_order",
          entityId: open.id,
          summary: `PO #${open.poNumber} reorder lines merged`,
          metadata: { supplierId, addedLineCount: lines.length, addedTotal: money(added) },
          actorType: actor.actorType,
        }, tx);
      } else {
        const [{ max }] = await tx.select({ max: sql<number>`COALESCE(MAX(${purchaseOrders.poNumber}), 0)` }).from(purchaseOrders);
        const poNumber = Number(max) + 1;

        const [po] = await tx.insert(purchaseOrders).values({
          tenantId: actor.tenantId,
          branchId: actor.branchId,
          supplierId,
          poNumber,
          status: "draft",
          total: money(added),
          createdByUserId: actor.actorUserId,
        }).returning({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber });

        for (const l of lines) {
          await tx.insert(purchaseOrderLines).values({
            tenantId: actor.tenantId,
            poId: po.id,
            itemId: l.itemId,
            qtyOrdered: qty(l.qtyOrdered),
            uom: l.uom,
            unitCost: money(l.unitCost),
            qtyReceived: "0",
          });
        }

        await recordAuditEvent(auditCtx(actor), {
          action: "po.created",
          entityType: "purchase_order",
          entityId: po.id,
          summary: `PO #${po.poNumber} drafted from reorder`,
          metadata: { supplierId, lineCount: lines.length },
          actorType: actor.actorType,
        }, tx);
        draftsCreated++;
      }
    }

    return { triggered: triggered.length, draftsCreated };
  });
}
