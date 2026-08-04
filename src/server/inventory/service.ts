import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { notify } from "@/server/notifications/service";
import {
  inventoryItems, inventoryLots, storageLocations, stockLedger, stockCounts, stockCountLines,
  productInventoryLinks, recipes, recipeComponents,
  type InventoryItem, type StorageLocation,
} from "./schema";
import { qty, roundQty, toBase, withWaste, scaleForYield, assertInventoryUom, type Uom } from "./uom";
import { OutOfStockError, InventoryConfigError } from "./errors";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Quantities are stored at scale 3, so anything under half a milli-unit is
 * noise, not a shortfall. The FIFO loop compares its running remainder against
 * this rather than `> 0` so a residue can never spin the loop.
 */
const EPS = 0.0005;

/**
 * The item's UoM columns come from the platform-wide enum, which is a superset
 * including P4's sellable m/m2/bf. Narrowing here means every conversion in this
 * module is on a stockable unit, and a mis-seeded item fails loudly at the first
 * movement rather than writing a nonsense quantity to the ledger.
 */
function stockable(item: InventoryItem): { baseUom: Uom; stockToBase: string; purchaseToBase: string; recipeToBase: string } {
  return {
    baseUom: assertInventoryUom(item.baseUom),
    stockToBase: item.stockToBase,
    purchaseToBase: item.purchaseToBase,
    recipeToBase: item.recipeToBase,
  };
}

/**
 * On-hand is a PROJECTION of the ledger — `Σ qty` — never a read of
 * `inventory_lots.qtyRemaining`, which is only a FIFO/expiry cache. When the two
 * disagree the ledger is right and the cache is rebuilt.
 */
export async function onHand(tenantId: string, itemId: string, locationId: string): Promise<number> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select({ sum: sql<string>`COALESCE(SUM(${stockLedger.qty}), 0)` }).from(stockLedger)
      .where(and(eq(stockLedger.itemId, itemId), eq(stockLedger.locationId, locationId))));
  return roundQty(Number(rows[0]?.sum ?? 0));
}

export async function getOrCreateDefaultLocation(
  tx: Tx, tenantId: string, branchId: string, kind: StorageLocation["kind"],
): Promise<StorageLocation> {
  const [existing] = await tx.select().from(storageLocations)
    .where(and(
      eq(storageLocations.branchId, branchId),
      eq(storageLocations.kind, kind),
      eq(storageLocations.isActive, true),
    ))
    .orderBy(sql`is_default DESC`).limit(1);
  if (existing) return existing;
  // Never block a sale on a missing location — provision the branch default lazily.
  const name = kind === "kitchen" ? "Kitchen" : kind === "retail" ? "Front Shelf" : kind === "back_of_house" ? "Back of House" : "Transit";
  const [created] = await tx.insert(storageLocations)
    .values({ tenantId, branchId, name, kind, isDefault: true })
    .returning();
  return created;
}

export type ReceiveArgs = {
  tenantId: string; itemId: string; locationId: string; baseQty: number; uom: Uom;
  unitCost?: string | null; lotCode?: string | null; supplierId?: string | null; poReceiptLineId?: string | null;
  expiryAt?: Date | null; receivedAt?: Date; byUserId?: string | null; note?: string | null;
  ledgerType?: "receive" | "adjustment";
};

/**
 * Creates a cost-bearing lot and the balancing positive ledger row in one tx.
 * `ledgerType` is `receive` for real deliveries; the backfill passes `adjustment`
 * so an opening balance is never mistaken for a purchase in consumption reports.
 *
 * Emits no audit event of its own: its callers (receiving against a PO, the
 * backfill, an adjustment route) own the operator-facing event, and the ledger
 * row is itself the immutable record of the movement.
 */
export async function receiveStock(tx: Tx, a: ReceiveArgs): Promise<{ lotId: string }> {
  const uom = assertInventoryUom(a.uom);
  const [lot] = await tx.insert(inventoryLots).values({
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotCode: a.lotCode ?? null,
    qtyReceived: qty(a.baseQty), qtyRemaining: qty(a.baseQty), unitCost: a.unitCost ?? "0",
    supplierId: a.supplierId ?? null, poReceiptLineId: a.poReceiptLineId ?? null,
    receivedAt: a.receivedAt ?? new Date(), expiryAt: a.expiryAt ?? null,
  }).returning({ id: inventoryLots.id });

  await tx.insert(stockLedger).values({
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId: lot.id,
    type: a.ledgerType ?? "receive", qty: qty(a.baseQty), uom, unitCost: a.unitCost ?? null,
    refType: "inventory_lot", refId: lot.id, byUserId: a.byUserId ?? null, note: a.note ?? null,
  });
  return { lotId: lot.id };
}

export type AdjustArgs = {
  tenantId: string; itemId: string; locationId: string; baseQty: number; uom: Uom;
  type?: "adjustment" | "waste"; lotId?: string | null; byUserId?: string | null; note?: string | null;
  audit?: AuditActorInput;
};

/**
 * A signed correction. Waste is an explicit `waste` row, never a silent
 * decrement, so shrinkage is reportable (Spec 10) rather than invisible.
 *
 * When a lot is named its cache moves too; a bulk adjustment with no lot moves
 * on-hand without attributing it to a cost layer, which is why counts and waste
 * should name a lot where one is known.
 */
export async function adjustStock(tx: Tx, a: AdjustArgs): Promise<void> {
  const uom = assertInventoryUom(a.uom);
  const signed = roundQty(a.baseQty);
  await tx.insert(stockLedger).values({
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId: a.lotId ?? null,
    type: a.type ?? "adjustment", qty: qty(signed), uom,
    refType: "adjustment", refId: null, byUserId: a.byUserId ?? null, note: a.note ?? null,
  });
  if (a.lotId) {
    await tx.update(inventoryLots)
      .set({ qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${qty(signed)}` })
      .where(eq(inventoryLots.id, a.lotId));
  }
  if (a.audit) {
    await recordAuditEvent({ tenantId: a.tenantId, actorUserId: a.audit.actorUserId, fingerprint: a.audit.fingerprint }, {
      action: a.type === "waste" ? "inventory.waste" : "inventory.adjust",
      entityType: "inventory_item", entityId: a.itemId,
      summary: `${a.type === "waste" ? "Wasted" : "Adjusted"} ${qty(signed)} ${a.uom}`,
      metadata: { locationId: a.locationId, baseQty: qty(signed), uom: a.uom, lotId: a.lotId ?? null, note: a.note ?? null },
      actorType: a.audit.actorType,
    }, tx);
  }
}

export type TransferArgs = {
  tenantId: string; itemId: string; fromLocationId: string; toLocationId: string;
  baseQty: number; uom: Uom; byUserId?: string | null; note?: string | null;
  audit?: AuditActorInput;
};

/**
 * Two balanced rows sharing one group id, so a transfer nets to zero across the
 * tenant while moving on-hand between locations. Written as a pair rather than a
 * mutation precisely because the ledger is append-only.
 */
export async function transferStock(tx: Tx, a: TransferArgs): Promise<void> {
  const uom = assertInventoryUom(a.uom);
  const amount = roundQty(a.baseQty);
  if (amount <= 0) throw new InventoryConfigError("a transfer quantity must be positive");
  const groupId = randomUUID();
  for (const [locationId, signed] of [[a.fromLocationId, -amount], [a.toLocationId, amount]] as const) {
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: a.itemId, locationId, lotId: null, type: "transfer",
      qty: qty(signed), uom, refType: "transfer", refId: groupId,
      byUserId: a.byUserId ?? null, note: a.note ?? null,
    });
  }
  if (a.audit) {
    await recordAuditEvent({ tenantId: a.tenantId, actorUserId: a.audit.actorUserId, fingerprint: a.audit.fingerprint }, {
      action: "inventory.transfer", entityType: "inventory_item", entityId: a.itemId,
      summary: `Transferred ${qty(amount)} ${a.uom} between locations`,
      metadata: { fromLocationId: a.fromLocationId, toLocationId: a.toLocationId, baseQty: qty(amount), uom: a.uom, groupId },
      actorType: a.audit.actorType,
    }, tx);
  }
}

/**
 * Commits a physical count: one `count` ledger row per line for
 * `countedQty − systemQty`, reconciling the system to what is actually on the
 * shelf. Lines whose variance is zero write nothing — a count that found no
 * discrepancy should not inflate the ledger.
 */
export async function commitCount(
  tx: Tx, tenantId: string, countId: string, byUserId: string | null, audit?: AuditActorInput,
): Promise<void> {
  const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId)).limit(1);
  if (!count) throw new InventoryConfigError("stock count not found");
  if (count.status !== "open") throw new InventoryConfigError(`stock count is already ${count.status}`);

  const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, countId));
  let varianceLines = 0;
  for (const line of lines) {
    const variance = roundQty(Number(line.countedQty) - Number(line.systemQty));
    if (Math.abs(variance) < EPS) continue;
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, line.itemId)).limit(1);
    if (!item) throw new InventoryConfigError("counted item missing");
    varianceLines += 1;
    await tx.insert(stockLedger).values({
      tenantId, itemId: line.itemId, locationId: count.locationId, lotId: null, type: "count",
      qty: qty(variance), uom: assertInventoryUom(item.baseUom),
      refType: "stock_count", refId: countId, byUserId, note: line.note ?? null,
    });
  }

  await tx.update(stockCounts)
    .set({ status: "committed", committedByUserId: byUserId, committedAt: new Date() })
    .where(eq(stockCounts.id, countId));

  if (audit) {
    await recordAuditEvent({ tenantId, actorUserId: audit.actorUserId, fingerprint: audit.fingerprint }, {
      action: "inventory.count.commit", entityType: "stock_count", entityId: countId,
      summary: `Committed stock count with ${varianceLines} variance line(s)`,
      metadata: { locationId: count.locationId, lines: lines.length, varianceLines },
      actorType: audit.actorType,
    }, tx);
  }
}

export type DeductArgs = {
  tenantId: string; branchId: string; productId: string; variantId: string | null;
  quantity: number; orderItemId: string; allowNegative: boolean; byUserId: string | null;
  productNameEn: string; productNameAr: string;
};

/**
 * Resolves a sold line to what it actually consumes, then deducts it.
 *
 * No `product_inventory_links` row means no deduction at all — that preserves
 * the behaviour of an untracked sellable under the flat integer counter, and is
 * what lets a restaurant switch `inventory` on before any recipe exists without
 * its menu becoming unsellable.
 *
 * Emits no audit event: this runs inside placeOrder, whose own event records the
 * sale, and the `sale_deduction` ledger rows are the immutable trail of what the
 * sale consumed.
 */
export async function deductForOrderLine(tx: Tx, a: DeductArgs): Promise<void> {
  const [link] = await tx.select().from(productInventoryLinks).where(and(
    eq(productInventoryLinks.productId, a.productId),
    a.variantId ? eq(productInventoryLinks.variantId, a.variantId) : sql`variant_id IS NULL`,
  )).limit(1);
  if (!link) return;

  if (link.linkType === "finished_good") {
    if (!link.itemId) throw new InventoryConfigError("finished-goods link has no item");
    const loc = await getOrCreateDefaultLocation(tx, a.tenantId, a.branchId, "retail");
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, link.itemId)).limit(1);
    if (!item) throw new InventoryConfigError("linked finished-goods item missing");
    // A finished good sells in its own base unit, so the integer sold qty IS the base qty.
    await deductFifo(tx, a, item, loc.id, a.quantity);
    return;
  }

  if (!link.recipeId) throw new InventoryConfigError("recipe link has no recipe");
  const loc = await getOrCreateDefaultLocation(tx, a.tenantId, a.branchId, "kitchen");
  const [recipe] = await tx.select().from(recipes).where(eq(recipes.id, link.recipeId)).limit(1);
  if (!recipe) throw new InventoryConfigError("linked recipe missing");
  const comps = await tx.select().from(recipeComponents).where(eq(recipeComponents.recipeId, recipe.id));
  for (const c of comps) {
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, c.itemId)).limit(1);
    if (!item) throw new InventoryConfigError("recipe component item missing");
    const perBatch = withWaste(toBase(Number(c.qty), assertInventoryUom(c.uom), stockable(item)), Number(c.wastePct));
    const need = scaleForYield(perBatch, a.quantity, Number(recipe.yieldQty));
    await deductFifo(tx, a, item, loc.id, need);
  }
}

/**
 * FIFO across an item's lots at one location.
 *
 * The guarded `UPDATE ... WHERE qty_remaining >= take` is the serialization
 * point, exactly as `stockQuantity >= quantity` was on the flat counter: under
 * READ COMMITTED the second concurrent writer re-evaluates its WHERE against the
 * newly committed row, so two sales cannot both claim the last unit of a lot. A
 * loser simply re-reads and continues to the next candidate lot.
 */
async function deductFifo(
  tx: Tx, a: DeductArgs, item: InventoryItem, locationId: string, needBase: number,
): Promise<void> {
  const baseUom = assertInventoryUom(item.baseUom);
  let need = roundQty(needBase);
  if (need <= EPS) return;

  // Perishables consume soonest-expiry first; everything else oldest-received.
  const order = item.isPerishable
    ? sql`expiry_at ASC NULLS LAST, received_at ASC`
    : sql`received_at ASC`;

  // The bound is a safety net against a pathological lot set, not an expected path.
  for (let guard = 0; need > EPS && guard < 10_000; guard++) {
    const [lot] = await tx.select().from(inventoryLots).where(and(
      eq(inventoryLots.itemId, item.id),
      eq(inventoryLots.locationId, locationId),
      sql`${inventoryLots.qtyRemaining} > 0`,
    )).orderBy(order).limit(1);
    if (!lot) break;

    const take = roundQty(Math.min(need, Number(lot.qtyRemaining)));
    if (take <= EPS) break;

    const hit = await tx.update(inventoryLots)
      .set({ qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${qty(take)}` })
      .where(and(eq(inventoryLots.id, lot.id), sql`${inventoryLots.qtyRemaining} >= ${qty(take)}`))
      .returning({ id: inventoryLots.id });
    if (hit.length === 0) continue; // a concurrent sale took it first — try the next lot

    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: item.id, locationId, lotId: lot.id, type: "sale_deduction",
      qty: qty(-take), uom: baseUom, unitCost: lot.unitCost,
      refType: "order_item", refId: a.orderItemId, byUserId: a.byUserId,
    });
    need = roundQty(need - take);
  }

  if (need > EPS) {
    // Retail cannot sell a can it does not have; the order rolls back whole.
    if (!a.allowNegative) throw new OutOfStockError(a.productNameEn, a.productNameAr);

    // Kitchen policy: the dish is already made and the customer is at the till,
    // so record the shortfall against no lot, let on-hand go negative, and tell
    // a manager. Failing the sale here would be the wrong trade.
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: item.id, locationId, lotId: null, type: "sale_deduction",
      qty: qty(-need), uom: baseUom, refType: "order_item", refId: a.orderItemId,
      byUserId: a.byUserId, note: "shortfall — allowNegativeStock",
    });

    // Runs on OUR tx, so the alert commits with the sale or not at all, and it
    // never touches the network — the outbox worker sends.
    await notify({ tenantId: a.tenantId }, {
      type: "low_stock",
      severity: "warning",
      title: `${item.nameEn} oversold`,
      body: `${item.nameEn} went ${qty(need)} ${baseUom} below zero — on-hand stays negative until a count or delivery reconciles it.`,
      entityType: "inventory_item",
      entityId: item.id,
      targets: [{ role: "owner" }, { role: "manager" }],
      channels: ["in_app", "email"],
      branchId: a.branchId,
    }, tx);
  }
}

export type ReverseArgs = {
  tenantId: string; orderId: string; orderItemIds?: string[]; byUserId?: string | null;
};

/**
 * Reverses a sale's deductions by appending `refund_restock` rows — never by
 * editing the originals, which the append-only trigger forbids anyway.
 *
 * Each reversal restores the SAME lot it came from, so FIFO cost layers stay
 * honest instead of a returned item silently re-entering stock at the wrong
 * cost. A shortfall row (lotId null) is reversed as another lot-less row.
 */
export async function reverseOrderDeductions(tx: Tx, a: ReverseArgs): Promise<void> {
  const rows = await tx.select().from(stockLedger).where(and(
    eq(stockLedger.type, "sale_deduction"),
    eq(stockLedger.refType, "order_item"),
    // Refunds (Spec 3) reverse named lines; a cancel reverses the whole order.
    a.orderItemIds?.length
      ? inArray(stockLedger.refId, a.orderItemIds)
      : sql`${stockLedger.refId} IN (SELECT id::text FROM order_items WHERE order_id = ${a.orderId})`,
  ));

  for (const row of rows) {
    // Already reversed? Then this is a re-entrant cancel and must not double-restock.
    const [existing] = await tx.select({ id: stockLedger.id }).from(stockLedger).where(and(
      eq(stockLedger.type, "refund_restock"),
      eq(stockLedger.refType, "stock_ledger"),
      eq(stockLedger.refId, row.id),
    )).limit(1);
    if (existing) continue;

    const amount = roundQty(-Number(row.qty)); // the original is negative
    if (amount <= EPS) continue;

    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: row.itemId, locationId: row.locationId, lotId: row.lotId,
      type: "refund_restock", qty: qty(amount), uom: row.uom, unitCost: row.unitCost,
      refType: "stock_ledger", refId: row.id, byUserId: a.byUserId ?? null,
    });

    if (row.lotId) {
      await tx.update(inventoryLots)
        .set({ qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${qty(amount)}` })
        .where(eq(inventoryLots.id, row.lotId));
    }
  }
}
