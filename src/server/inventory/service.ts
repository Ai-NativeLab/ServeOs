import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { notify } from "@/server/notifications/service";
// Schema only — importing catalog's SERVICE here would close a cycle, since
// catalog/variants.ts calls into this module.
import { products, productVariants } from "@/server/catalog/schema";
import {
  inventoryItems, inventoryLots, storageLocations, stockLedger, stockCounts, stockCountLines,
  productInventoryLinks, recipes, recipeComponents,
  type InventoryItem, type StorageLocation,
} from "./schema";
import { qty, roundQty, toBase, withWaste, scaleForYield, assertInventoryUom, type Uom } from "./uom";
import type { UnitOfMeasure } from "@/server/catalog/uom-values";
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
async function loadItem(tx: Tx, itemId: string): Promise<InventoryItem> {
  const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, itemId)).limit(1);
  if (!item) throw new InventoryConfigError("inventory item not found");
  return item;
}

function baseUomOf(item: InventoryItem): Uom {
  return assertInventoryUom(item.baseUom);
}

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
  return withTenant(tenantId, (tx) => onHandOnTx(tx, itemId, locationId));
}

/**
 * The single definition of on-hand for an (item, location). Everything that
 * needs the figure inside a transaction calls this — the count snapshot, the
 * legacy-integer mirror, the catalog reconciler — so the invariant exists once
 * rather than in four copies that can quietly drift apart.
 */
export async function onHandOnTx(tx: Tx, itemId: string, locationId: string): Promise<number> {
  const [row] = await tx.select({ sum: sql<string>`COALESCE(SUM(${stockLedger.qty}), 0)` }).from(stockLedger)
    .where(and(eq(stockLedger.itemId, itemId), eq(stockLedger.locationId, locationId)));
  return roundQty(Number(row?.sum ?? 0));
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
  // Two concurrent first sales at a branch both reach here, so the insert relies
  // on the partial unique index (one default per branch+kind): the loser conflicts,
  // does nothing, and re-reads the winner's row. Without that, each would create
  // its own shelf and the branch's stock would split across them at random.
  const name = kind === "kitchen" ? "Kitchen" : kind === "retail" ? "Front Shelf" : kind === "back_of_house" ? "Back of House" : "Transit";
  const [created] = await tx.insert(storageLocations)
    .values({ tenantId, branchId, name, kind, isDefault: true })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [winner] = await tx.select().from(storageLocations).where(and(
    eq(storageLocations.branchId, branchId),
    eq(storageLocations.kind, kind),
    eq(storageLocations.isDefault, true),
  )).limit(1);
  if (!winner) throw new InventoryConfigError("could not resolve a default storage location");
  return winner;
}

/**
 * Converts a caller's quantity into the item's base unit.
 *
 * Every writer goes through this. The ledger stores base units only, and
 * `onHand` sums `qty` blind, so a row whose number is not in base units is
 * silently wrong by whatever the factor was — 2 kg recorded as 2 g.
 *
 * `factorKind` uses the item's own declared conversion (a 24-can case, counting
 * in kg while holding in g) instead of the dimensional one; that is what those
 * columns are for.
 */
function toBaseQty(
  item: InventoryItem, value: number, uom: UnitOfMeasure,
  factorKind?: "stock" | "purchase" | "recipe",
): number {
  return toBase(value, assertInventoryUom(uom), stockable(item), factorKind);
}

/**
 * Adds a lot carrying `baseQty`. Every positive movement needs one: on-hand is
 * the ledger, but FIFO can only consume lots, so a credit that skips this
 * produces stock the reports show and no sale can ever reach.
 */
async function creditLot(
  tx: Tx, a: {
    tenantId: string; itemId: string; locationId: string; baseQty: number;
    unitCost?: string | null; lotCode?: string | null; supplierId?: string | null;
    poReceiptLineId?: string | null; receivedAt?: Date; expiryAt?: Date | null;
  },
): Promise<string> {
  const [lot] = await tx.insert(inventoryLots).values({
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotCode: a.lotCode ?? null,
    qtyReceived: qty(a.baseQty), qtyRemaining: qty(a.baseQty), unitCost: a.unitCost ?? "0",
    supplierId: a.supplierId ?? null, poReceiptLineId: a.poReceiptLineId ?? null,
    receivedAt: a.receivedAt ?? new Date(), expiryAt: a.expiryAt ?? null,
  }).returning({ id: inventoryLots.id });
  return lot.id;
}

export type LotTake = { lotId: string; baseQty: number; unitCost: string | null };

/**
 * Consumes `baseQty` FIFO across an item's lots at one location, returning what
 * each lot gave up plus any unmet remainder.
 *
 * The guarded `UPDATE ... WHERE qty_remaining >= take` is the serialization
 * point: under READ COMMITTED a concurrent writer re-evaluates against the newly
 * committed row, so two callers cannot both claim the last unit. A loser simply
 * moves to the next lot.
 *
 * `includeExpired` is false for sales — expired stock must never go out of the
 * door — and true for waste and write-offs, which is precisely how expired stock
 * leaves.
 */
async function debitLots(
  tx: Tx, item: InventoryItem, locationId: string, baseQty: number,
  opts: { includeExpired?: boolean } = {},
): Promise<{ taken: LotTake[]; shortfall: number }> {
  let need = roundQty(baseQty);
  const taken: LotTake[] = [];
  if (need <= EPS) return { taken, shortfall: 0 };

  const order = item.isPerishable
    ? sql`expiry_at ASC NULLS LAST, received_at ASC`
    : sql`received_at ASC`;

  for (let guard = 0; need > EPS && guard < 10_000; guard++) {
    const where = [
      eq(inventoryLots.itemId, item.id),
      eq(inventoryLots.locationId, locationId),
      sql`${inventoryLots.qtyRemaining} > 0`,
      opts.includeExpired ? undefined : sql`(${inventoryLots.expiryAt} IS NULL OR ${inventoryLots.expiryAt} > now())`,
    ].filter(Boolean);

    const [lot] = await tx.select().from(inventoryLots)
      .where(and(...where)).orderBy(order).limit(1);
    if (!lot) break;

    const take = roundQty(Math.min(need, Number(lot.qtyRemaining)));
    if (take <= EPS) break;

    const hit = await tx.update(inventoryLots)
      .set({ qtyRemaining: sql`${inventoryLots.qtyRemaining} - ${qty(take)}` })
      .where(and(eq(inventoryLots.id, lot.id), sql`${inventoryLots.qtyRemaining} >= ${qty(take)}`))
      .returning({ id: inventoryLots.id });
    if (hit.length === 0) continue; // a concurrent writer took it — try the next lot

    taken.push({ lotId: lot.id, baseQty: take, unitCost: lot.unitCost });
    need = roundQty(need - take);
  }
  return { taken, shortfall: need > EPS ? need : 0 };
}

export type ReceiveArgs = {
  tenantId: string; itemId: string; locationId: string; baseQty: number; uom: Uom;
  unitCost?: string | null; lotCode?: string | null; supplierId?: string | null; poReceiptLineId?: string | null;
  expiryAt?: Date | null; receivedAt?: Date; byUserId?: string | null; note?: string | null;
  ledgerType?: "receive" | "adjustment";
  /** Use the item's own conversion (e.g. a 24-can purchase case) instead of the dimensional one. */
  factorKind?: "stock" | "purchase" | "recipe";
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
  const item = await loadItem(tx, a.itemId);
  // `baseQty` is a misnomer kept for callers: the quantity is interpreted in
  // `uom` and converted, so receiving "2 kg" of a gram-based item books 2000 g.
  // `factorKind: purchase` lets an item declare that its purchase unit is a
  // 24-can case rather than a dimensional conversion.
  const baseQty = toBaseQty(item, a.baseQty, a.uom, a.factorKind);
  const lotId = await creditLot(tx, {
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, baseQty,
    unitCost: a.unitCost, lotCode: a.lotCode, supplierId: a.supplierId,
    poReceiptLineId: a.poReceiptLineId, receivedAt: a.receivedAt, expiryAt: a.expiryAt,
  });

  await tx.insert(stockLedger).values({
    tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId,
    type: a.ledgerType ?? "receive", qty: qty(baseQty), uom: baseUomOf(item), unitCost: a.unitCost ?? null,
    refType: "inventory_lot", refId: lotId, byUserId: a.byUserId ?? null, note: a.note ?? null,
  });
  await syncLinkedSellable(tx, a.itemId, a.locationId);
  return { lotId };
}

export type AdjustArgs = {
  tenantId: string; itemId: string; locationId: string; baseQty: number; uom: Uom;
  type?: "adjustment" | "waste"; lotId?: string | null; byUserId?: string | null; note?: string | null;
  audit?: AuditActorInput;
};

/**
 * A signed correction, in `uom`, converted to the item's base unit.
 *
 * Waste is an explicit `waste` row, never a silent decrement, so shrinkage stays
 * reportable rather than invisible.
 *
 * The lot cache is maintained either way, which is the point: an INCREASE with
 * no lot would otherwise raise on-hand while creating nothing FIFO can consume,
 * so a shelf could read "10 in stock" and refuse every sale. A DECREASE draws
 * FIFO across lots (including expired ones — writing those off is exactly what
 * waste is for) and records what it could not cover, so the ledger still balances
 * to the on-hand figure a count produced.
 */
export async function adjustStock(tx: Tx, a: AdjustArgs): Promise<void> {
  const item = await loadItem(tx, a.itemId);
  const signed = roundQty(toBaseQty(item, a.baseQty, a.uom));
  const uom = baseUomOf(item);
  const type = a.type ?? "adjustment";

  if (a.lotId) {
    // An explicitly targeted lot: move that cost layer and nothing else.
    await tx.update(inventoryLots)
      .set({ qtyRemaining: sql`${inventoryLots.qtyRemaining} + ${qty(signed)}` })
      .where(eq(inventoryLots.id, a.lotId));
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId: a.lotId,
      type, qty: qty(signed), uom, refType: "adjustment", refId: null,
      byUserId: a.byUserId ?? null, note: a.note ?? null,
    });
  } else if (signed > 0) {
    const lotId = await creditLot(tx, {
      tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId,
      baseQty: signed, unitCost: item.defaultUnitCost,
    });
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId,
      type, qty: qty(signed), uom, unitCost: item.defaultUnitCost,
      refType: "adjustment", refId: null, byUserId: a.byUserId ?? null, note: a.note ?? null,
    });
  } else if (signed < 0) {
    const { taken, shortfall } = await debitLots(tx, item, a.locationId, -signed, { includeExpired: true });
    for (const t of taken) {
      await tx.insert(stockLedger).values({
        tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId: t.lotId,
        type, qty: qty(-t.baseQty), uom, unitCost: t.unitCost,
        refType: "adjustment", refId: null, byUserId: a.byUserId ?? null, note: a.note ?? null,
      });
    }
    if (shortfall > EPS) {
      // More was written off than any lot holds. Recorded against no lot so
      // on-hand still lands where the operator says it should.
      await tx.insert(stockLedger).values({
        tenantId: a.tenantId, itemId: a.itemId, locationId: a.locationId, lotId: null,
        type, qty: qty(-shortfall), uom, refType: "adjustment", refId: null,
        byUserId: a.byUserId ?? null, note: a.note ?? "adjustment beyond available lots",
      });
    }
  }

  await syncLinkedSellable(tx, a.itemId, a.locationId);

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
  const item = await loadItem(tx, a.itemId);
  const amount = roundQty(toBaseQty(item, a.baseQty, a.uom));
  if (amount <= 0) throw new InventoryConfigError("a transfer quantity must be positive");
  const uom = baseUomOf(item);
  const groupId = randomUUID();

  // Lots move with the stock, not just the ledger. Writing only the two ledger
  // rows would leave the destination with on-hand it has no lot to sell from,
  // while the source kept lots it no longer owns — the same quantity at once
  // unsellable there and still sellable here.
  const { taken, shortfall } = await debitLots(tx, item, a.fromLocationId, amount, { includeExpired: true });
  if (shortfall > EPS) {
    throw new InventoryConfigError("not enough stock at the source location to transfer");
  }

  for (const t of taken) {
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: a.itemId, locationId: a.fromLocationId, lotId: t.lotId,
      type: "transfer", qty: qty(-t.baseQty), uom, unitCost: t.unitCost,
      refType: "transfer", refId: groupId, byUserId: a.byUserId ?? null, note: a.note ?? null,
    });
    // A fresh lot at the destination, carrying the source lot's cost so the
    // move does not silently re-cost the goods.
    const lotId = await creditLot(tx, {
      tenantId: a.tenantId, itemId: a.itemId, locationId: a.toLocationId,
      baseQty: t.baseQty, unitCost: t.unitCost,
    });
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: a.itemId, locationId: a.toLocationId, lotId,
      type: "transfer", qty: qty(t.baseQty), uom, unitCost: t.unitCost,
      refType: "transfer", refId: groupId, byUserId: a.byUserId ?? null, note: a.note ?? null,
    });
  }

  await syncLinkedSellable(tx, a.itemId, a.fromLocationId);
  await syncLinkedSellable(tx, a.itemId, a.toLocationId);

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
 * Adds counted lines to an OPEN count, snapshotting each item's `systemQty` at
 * the moment that line is entered. Counting a stockroom is not instantaneous —
 * lines arrive in batches as someone walks the shelves — so snapshotting per
 * line measures each variance against what the system believed when that shelf
 * was actually counted.
 *
 * Re-counting an item REPLACES its earlier line rather than appending a second,
 * so a corrected figure is not applied twice at commit.
 */
export async function addCountLines(
  tx: Tx, tenantId: string, countId: string, lines: { itemId: string; countedQty: number }[],
): Promise<void> {
  if (lines.length === 0) return;
  const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId)).limit(1);
  if (!count) throw new InventoryConfigError("stock count not found");
  if (count.status !== "open") throw new InventoryConfigError(`stock count is already ${count.status}`);

  for (const line of lines) {
    const system = await onHandOnTx(tx, line.itemId, count.locationId);
    const counted = roundQty(line.countedQty);

    await tx.delete(stockCountLines).where(and(
      eq(stockCountLines.countId, countId), eq(stockCountLines.itemId, line.itemId),
    ));
    await tx.insert(stockCountLines).values({
      tenantId, countId, itemId: line.itemId,
      systemQty: qty(system), countedQty: qty(counted), varianceQty: qty(counted - system),
    });
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
    const item = await loadItem(tx, line.itemId);
    const uom = baseUomOf(item);
    varianceLines += 1;

    // Counted quantities are already in the item's base unit (addCountLines
    // snapshots systemQty from the ledger), so no conversion here — but the lot
    // cache still has to follow, or a surplus would show as on-hand that no sale
    // can reach and a shortage would leave lots holding stock the shelf lacks.
    if (variance > 0) {
      const lotId = await creditLot(tx, {
        tenantId, itemId: line.itemId, locationId: count.locationId,
        baseQty: variance, unitCost: item.defaultUnitCost, lotCode: "COUNT-SURPLUS",
      });
      await tx.insert(stockLedger).values({
        tenantId, itemId: line.itemId, locationId: count.locationId, lotId, type: "count",
        qty: qty(variance), uom, unitCost: item.defaultUnitCost,
        refType: "stock_count", refId: countId, byUserId, note: line.note ?? null,
      });
    } else {
      const { taken, shortfall } = await debitLots(tx, item, count.locationId, -variance, { includeExpired: true });
      for (const t of taken) {
        await tx.insert(stockLedger).values({
          tenantId, itemId: line.itemId, locationId: count.locationId, lotId: t.lotId, type: "count",
          qty: qty(-t.baseQty), uom, unitCost: t.unitCost,
          refType: "stock_count", refId: countId, byUserId, note: line.note ?? null,
        });
      }
      if (shortfall > EPS) {
        await tx.insert(stockLedger).values({
          tenantId, itemId: line.itemId, locationId: count.locationId, lotId: null, type: "count",
          qty: qty(-shortfall), uom, refType: "stock_count", refId: countId, byUserId,
          note: line.note ?? "counted below what the lots held",
        });
      }
    }
  }

  for (const itemId of new Set(lines.map((l) => l.itemId))) {
    await syncLinkedSellable(tx, itemId, count.locationId);
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

/**
 * Adopts a sellable that is still tracking stock the legacy way — `trackStock`
 * with a non-null `stockQuantity` and no `product_inventory_links` row — by
 * creating its item, link and opening lot on first sale.
 *
 * This exists because deduction is now gated entirely on a link, while the
 * catalog still writes the legacy integer from four places (createProduct,
 * updateProduct, upsertVariant, setProductStock). The backfill only covered rows
 * that existed when it ran, so anything created afterwards would have sold
 * without limit — the guarded integer UPDATE that used to stop it is gone.
 * Self-healing here covers every writer instead of hooking each one, and it
 * fires once per sellable.
 *
 * Returns null for a genuinely untracked sellable, which must keep selling
 * freely.
 */
async function adoptLegacyTrackedStock(
  tx: Tx, tenantId: string, productId: string, variantId: string | null, locationId: string,
): Promise<string | null> {
  let nameEn: string, nameAr: string, sku: string | null, legacyQty: number | null;

  if (variantId) {
    const [v] = await tx.select().from(productVariants).where(eq(productVariants.id, variantId)).limit(1);
    if (!v || v.stockQuantity === null) return null;
    ({ nameEn, nameAr, sku } = v);
    legacyQty = v.stockQuantity;
  } else {
    const [p] = await tx.select().from(products).where(eq(products.id, productId)).limit(1);
    if (!p || !p.trackStock || p.stockQuantity === null) return null;
    ({ nameEn, nameAr, sku } = p);
    legacyQty = p.stockQuantity;
  }

  const [item] = await tx.insert(inventoryItems).values({
    tenantId, nameEn, nameAr, sku, kind: "finished_good",
    baseUom: "each", stockUom: "each", purchaseUom: "each", recipeUom: "each",
  }).returning({ id: inventoryItems.id });

  await tx.insert(productInventoryLinks).values({
    tenantId, productId, variantId, linkType: "finished_good", itemId: item.id,
  });

  if (legacyQty > 0) {
    const lotId = await creditLot(tx, { tenantId, itemId: item.id, locationId, baseQty: legacyQty });
    await tx.insert(stockLedger).values({
      tenantId, itemId: item.id, locationId, lotId, type: "adjustment",
      qty: qty(legacyQty), uom: "each", refType: "inventory_lot", refId: lotId,
      note: "opening balance (adopted on first sale)",
    });
  }
  return item.id;
}

/**
 * Writes on-hand back to the legacy `stockQuantity` integer.
 *
 * The storefront's `inStock` flag still reads that column, and sales no longer
 * touch it, so without this a sold-out product would advertise itself as
 * available forever and every customer would hit an error at checkout instead of
 * a disabled button. Dropped along with the column once `inStock` reads the
 * ledger (spec Migration §5).
 */
/**
 * What can actually be SOLD at a location: on-hand minus anything sitting in an
 * expired lot.
 *
 * On-hand and sellable are deliberately different numbers — expired stock is
 * still held and still counted, it just cannot go out of the door. The storefront
 * needs the sellable figure: mirroring raw on-hand would advertise a shelf of
 * expired goods as available and then fail the customer at checkout, which is the
 * same "advertises then errors" trap as a sold-out product.
 */
export async function sellableOnHand(tx: Tx, itemId: string, locationId: string): Promise<number> {
  const [row] = await tx.select({
    sum: sql<string>`COALESCE(SUM(${inventoryLots.qtyRemaining}), 0)`,
  }).from(inventoryLots).where(and(
    eq(inventoryLots.itemId, itemId),
    eq(inventoryLots.locationId, locationId),
    sql`${inventoryLots.qtyRemaining} > 0`,
    sql`(${inventoryLots.expiryAt} IS NULL OR ${inventoryLots.expiryAt} > now())`,
  ));
  return roundQty(Number(row?.sum ?? 0));
}

/**
 * Re-mirrors every sellable linked to this item at this location.
 *
 * Called from every write path, not just sales: a manager who receives, adjusts,
 * transfers or counts stock through the inventory API moves the ledger, and
 * without this the storefront would keep showing the figure from before —
 * hiding stock that exists, or offering stock that does not.
 */
export async function syncLinkedSellable(tx: Tx, itemId: string, locationId: string): Promise<void> {
  const links = await tx.select().from(productInventoryLinks)
    .where(and(eq(productInventoryLinks.itemId, itemId), eq(productInventoryLinks.linkType, "finished_good")));
  for (const link of links) {
    await mirrorLegacyStock(tx, itemId, locationId, link.productId, link.variantId);
  }
}

async function mirrorLegacyStock(
  tx: Tx, itemId: string, locationId: string, productId: string, variantId: string | null,
): Promise<void> {
  const remaining = Math.max(0, Math.floor(await sellableOnHand(tx, itemId, locationId)));

  if (variantId) {
    await tx.update(productVariants)
      .set({ stockQuantity: remaining })
      .where(and(eq(productVariants.id, variantId), sql`stock_quantity IS NOT NULL`));
  } else {
    await tx.update(products)
      .set({ stockQuantity: remaining })
      .where(and(eq(products.id, productId), eq(products.trackStock, true)));
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
  // Prefer the variant's own link, then fall back to the product's base link.
  // Without the fallback, a product linked at the base level sells its variants
  // without deducting anything at all — silently, and only for variants.
  let link: typeof productInventoryLinks.$inferSelect | undefined;
  if (a.variantId) {
    [link] = await tx.select().from(productInventoryLinks).where(and(
      eq(productInventoryLinks.productId, a.productId),
      eq(productInventoryLinks.variantId, a.variantId),
    )).limit(1);
  }
  if (!link) {
    [link] = await tx.select().from(productInventoryLinks).where(and(
      eq(productInventoryLinks.productId, a.productId),
      isNull(productInventoryLinks.variantId),
    )).limit(1);
  }

  if (!link) {
    // No link yet. Either this sellable is genuinely untracked (sell freely, as
    // the flat counter did for null stock), or it is still on the legacy integer
    // and needs adopting before it can be deducted from.
    const retail = await getOrCreateDefaultLocation(tx, a.tenantId, a.branchId, "retail");
    const adoptedItemId = await adoptLegacyTrackedStock(tx, a.tenantId, a.productId, a.variantId, retail.id);
    if (!adoptedItemId) return;
    const item = await loadItem(tx, adoptedItemId);
    await deductFifo(tx, a, item, retail.id, a.quantity);
    await mirrorLegacyStock(tx, adoptedItemId, retail.id, a.productId, a.variantId);
    return;
  }

  if (link.linkType === "finished_good") {
    if (!link.itemId) throw new InventoryConfigError("finished-goods link has no item");
    const loc = await getOrCreateDefaultLocation(tx, a.tenantId, a.branchId, "retail");
    const item = await loadItem(tx, link.itemId);
    // A finished good sells in its own base unit, so the integer sold qty IS the base qty.
    await deductFifo(tx, a, item, loc.id, a.quantity);
    // Keep the legacy integer in step so the storefront stops advertising a
    // sold-out item. Scoped to the linked (product, variant) this sale resolved.
    await mirrorLegacyStock(tx, item.id, loc.id, link.productId, link.variantId);
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
    // `recipe` factorKind lets an item declare how its recipe unit converts —
    // e.g. counted in kg but consumed in g — instead of only the dimensional route.
    const perBatch = withWaste(
      toBaseQty(item, Number(c.qty), c.uom, c.uom === item.recipeUom ? "recipe" : undefined),
      Number(c.wastePct),
    );
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
  const baseUom = baseUomOf(item);
  if (roundQty(needBase) <= EPS) return;

  // Sales never touch expired lots — expired stock must not go out of the door.
  const { taken, shortfall: need } = await debitLots(tx, item, locationId, needBase);
  for (const t of taken) {
    await tx.insert(stockLedger).values({
      tenantId: a.tenantId, itemId: item.id, locationId, lotId: t.lotId, type: "sale_deduction",
      qty: qty(-t.baseQty), uom: baseUom, unitCost: t.unitCost,
      refType: "order_item", refId: a.orderItemId, byUserId: a.byUserId,
    });
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

    // Always restore to the ORIGINAL lot, including one since drained to zero —
    // that is exactly the right cost layer for goods that came out of it.
    //
    // The spec asks for a "depleted/expired lot lands on a review lot" fallback
    // so a consumed cost layer is not resurrected. Neither half needs a second
    // lot here, and both reasons are structural rather than convenient:
    //   - A lot can never be MISSING. stock_ledger.lot_id references
    //     inventory_lots ON DELETE RESTRICT, so a lot with ledger rows cannot be
    //     deleted; a fallback for it would be unreachable code.
    //   - An EXPIRED lot is already excluded from deductFifo, so restoring to it
    //     puts the quantity back on hand — visible, and awaiting an explicit
    //     waste row — without it ever being resold as fresh. That IS the review
    //     outcome the spec wanted, reached through the expiry rule.
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
