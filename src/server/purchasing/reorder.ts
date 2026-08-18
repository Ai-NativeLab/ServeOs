import { sql, eq, inArray, and, asc } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import type { UnitOfMeasure } from "@/server/catalog/uom";
import { qty } from "@/server/inventory/uom";
import { money } from "@/server/ordering/service";
import { unitRate } from "./amounts";
import { notify } from "@/server/notifications/service";
import { inventoryItems } from "@/server/inventory/schema";
import { storageLocations } from "@/server/inventory/schema";
import { purchaseOrders, purchaseOrderLines, supplierItems, suppliers } from "./schema";
import { reorderRules } from "./reorder-schema";
import type { PurchasingActor } from "./suppliers";
import { InvalidPoInputError } from "./errors";
import { lockPoNumbering } from "./locking";

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

/**
 * Same rationale as service.ts's assertLineNumbers: the routes validate their
 * own bodies, but this is an exported service function the cron, scripts and
 * tests call directly. A zero or negative reorderQty becomes the qtyOrdered of
 * an auto-drafted PO line, so the floor has to live here and not only at the
 * HTTP edge.
 */
function assertRuleNumbers(input: ReorderRuleInput): void {
  if (!Number.isFinite(input.reorderPoint) || input.reorderPoint < 0) {
    throw new InvalidPoInputError(`reorderPoint must be a non-negative finite number (got ${input.reorderPoint})`);
  }
  if (!Number.isFinite(input.reorderQty) || input.reorderQty <= 0) {
    throw new InvalidPoInputError(`reorderQty must be a positive finite number (got ${input.reorderQty})`);
  }
}

export async function upsertReorderRule(actor: PurchasingActor, input: ReorderRuleInput): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    // No advisory key here. This writer takes its rule row lock via the
    // ON CONFLICT below and reaches hashtext(tenantId) only through its closing
    // recordAuditEvent — rows first, tenant key last, the same order checkReorder
    // follows. See ./locking.ts. (An earlier revision took the key first here
    // and described doing so in this comment; that inverted purchasing against
    // every other domain and is what deadlocked postReceipt || adjustStock.)
    assertRuleNumbers(input);

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
        // Changing the thresholds is an explicit "re-evaluate me": clearing the
        // debounce stamp means lowering a reorder point alerts on the next
        // sweep instead of waiting out the previous 24h window.
        lastAlertedAt: null,
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
 *  - Overlapping sweeps are serialized by `FOR UPDATE` on the reorder_rules rows
 *    themselves, taken with the debounce read. A rival run blocks there, and
 *    under READ COMMITTED re-reads the winner's committed `lastAlertedAt` when
 *    it unblocks, so it cannot double-notify or double-draft. Row locks, not an
 *    advisory key: see ./locking.ts for why the key must be taken last.
 *  - A supplier with an already-open draft PO has the new lines merged into it,
 *    so a chronically-low item cannot spawn a fresh draft every day forever.
 *  - Auto-drafted lines carry NO tax rate, deliberately. Nothing here knows the
 *    rate for a given item — the tenant's `vatRate` is its SALES rate, and much
 *    of what a restaurant buys is zero-rated or reduced, so stamping it on every
 *    line would be wrong more often than right. A draft is never sent
 *    automatically; the buyer states the tax when they review it, and until they
 *    do, `getPoVariance` showing the tax as an invoice discrepancy is the
 *    correct signal that it has not been captured.
 *  - Machine-written draft POs are audit-attributed by the caller: the cron
 *    passes an actor with actorType "system", an interactive check keeps the
 *    real user — the shared service never decides which it was.
 */
export async function checkReorder(actor: PurchasingActor): Promise<ReorderRun> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    // FOR UPDATE on the rule rows this sweep may stamp. The debounce is a
    // read-then-write on `lastAlertedAt`: without the lock two overlapping runs
    // read the same snapshot, both pass the 24h check and both notify (measured:
    // 4 rows for one low item), and when no draft exists yet the open-draft
    // lookup below matches nothing and locks nothing, so both also insert a
    // draft. Locking here makes the loser block and re-read the winner's commit.
    //
    // ORDER BY id so concurrent sweeps take these rows in one order — an
    // unordered scan can hand two backends different orders (synchronize_seqscans
    // is on by default), which is its own deadlock. This is also the first lock
    // the sweep takes, well before anything acquires hashtext(tenantId).
    const rules = await tx.select().from(reorderRules)
      .where(eq(reorderRules.isActive, true))
      .orderBy(asc(reorderRules.id))
      .for("update");
    if (rules.length === 0) return { triggered: 0, draftsCreated: 0 };

    const locRows = await tx.select({ id: storageLocations.id, name: storageLocations.name }).from(storageLocations);
    const locationName = new Map(locRows.map((l) => [l.id, l.name]));

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
        body: `On hand at ${locationName.get(rule.locationId) ?? rule.locationId} is ${onHand.get(`${rule.itemId}:${rule.locationId}`) ?? 0}, at or below the reorder point of ${Number(rule.reorderPoint)}.`,
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

    // PHASE 1 — ROWS ONLY. Every row lock the sweep needs is taken here, before
    // any statement that acquires `hashtext(tenantId)`. THE RULE (./locking.ts):
    // never hold that key while waiting for a row lock. Doing the lock and the
    // write together per supplier broke it on the SECOND iteration — the first
    // supplier's closing audit event took the key, and the next supplier's
    // `FOR UPDATE` then waited on a row while holding it, which is the exact
    // cycle that deadlocked 24/24 against send/update/cancel/receive in review
    // rounds 3 and 4. It is invisible to a single-supplier fixture.
    type SupplierPlan = {
      supplierId: string;
      open: { id: string; total: string | null; poNumber: number } | null;
      lines: { itemId: string; qtyOrdered: number; uom: UnitOfMeasure; unitCost: number }[];
      added: number;
    };
    const plans: SupplierPlan[] = [];

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
      // FOR UPDATE, not an advisory key: we are about to UPDATE this row, and
      // every other PO writer (send/update/cancel/receive) also takes the row
      // first and the tenant key last, via its closing audit event.
      const [open] = await tx.select({ id: purchaseOrders.id, total: purchaseOrders.total, poNumber: purchaseOrders.poNumber })
        .from(purchaseOrders)
        .where(and(
          eq(purchaseOrders.supplierId, supplierId),
          eq(purchaseOrders.branchId, actor.branchId),
          eq(purchaseOrders.status, "draft"),
        ))
        .orderBy(asc(purchaseOrders.poNumber))
        .for("update").limit(1);

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

      plans.push({ supplierId, open: open ?? null, lines, added });
    }

    // PHASE 2 — WRITES. From here on nothing waits on a row another transaction
    // could hold: the UPDATEs target drafts already locked in phase 1, and
    // everything else is an INSERT of a brand-new row. That is what makes it
    // safe for `lockPoNumbering` and `recordAuditEvent` to take the key here.
    let draftsCreated = 0;
    for (const plan of plans) {
      const { supplierId, open, lines, added } = plan;
      if (open) {
        // Merge: append the missing lines to the existing draft and bump its total.
        await tx.update(purchaseOrders)
          .set({ total: money(Number(open.total ?? 0) + added) })
          .where(eq(purchaseOrders.id, open.id));
        for (const l of lines) {
          await tx.insert(purchaseOrderLines).values({
            tenantId: actor.tenantId,
            poId: open.id,
            itemId: l.itemId,
            qtyOrdered: qty(l.qtyOrdered),
            uom: l.uom,
            unitCost: unitRate(l.unitCost),
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
        await lockPoNumbering(tx, actor.tenantId);
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
            unitCost: unitRate(l.unitCost),
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

export type ReorderRuleWithDetails = {
  id: string;
  tenantId: string;
  itemId: string;
  itemNameEn: string | null;
  locationId: string;
  locationName: string | null;
  reorderPoint: string;
  reorderQty: string;
  preferredSupplierId: string | null;
  preferredSupplierName: string | null;
  lastAlertedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
};

export async function listReorderRules(tenantId: string): Promise<ReorderRuleWithDetails[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        rule: reorderRules,
        itemNameEn: inventoryItems.nameEn,
        locationName: storageLocations.name,
        preferredSupplierName: suppliers.name,
      })
      .from(reorderRules)
      .leftJoin(inventoryItems, eq(inventoryItems.id, reorderRules.itemId))
      .leftJoin(storageLocations, eq(storageLocations.id, reorderRules.locationId))
      .leftJoin(suppliers, eq(suppliers.id, reorderRules.preferredSupplierId))
      .orderBy(asc(inventoryItems.nameEn));

    return rows.map((r) => ({
      ...r.rule,
      itemNameEn: r.itemNameEn,
      locationName: r.locationName,
      preferredSupplierName: r.preferredSupplierName,
    }));
  });
}
