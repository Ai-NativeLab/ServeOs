import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { inventoryItems, inventoryLots, storageLocations, stockLedger, stockCounts } from "./schema";
import type { InventoryItem, InventoryLot, StockCount, StorageLocation } from "./schema";

const MAX_LIMIT = 200;
const clamp = (limit?: number): number => Math.min(Math.max(limit ?? 50, 1), MAX_LIMIT);

export type ItemFilters = { kind?: InventoryItem["kind"]; isActive?: boolean; limit?: number };

export async function listItems(tenantId: string, f: ItemFilters = {}): Promise<InventoryItem[]> {
  return withTenant(tenantId, (tx) => {
    const where = [
      f.kind ? eq(inventoryItems.kind, f.kind) : undefined,
      f.isActive !== undefined ? eq(inventoryItems.isActive, f.isActive) : undefined,
    ].filter(Boolean);
    return tx.select().from(inventoryItems)
      .where(where.length ? and(...where) : undefined)
      .orderBy(inventoryItems.nameEn)
      .limit(clamp(f.limit));
  });
}

export async function listLocations(tenantId: string, branchId?: string): Promise<StorageLocation[]> {
  return withTenant(tenantId, (tx) => tx.select().from(storageLocations)
    .where(branchId ? eq(storageLocations.branchId, branchId) : undefined)
    .orderBy(storageLocations.name));
}

export type OnHandRow = {
  itemId: string; nameEn: string; nameAr: string; baseUom: string;
  locationId: string; locationName: string; onHand: number;
};

/**
 * On-hand per (item, location), summed from the LEDGER rather than the lot
 * cache, so this view cannot disagree with the source of truth. Locations with
 * no movements never appear; a location whose stock was oversold appears with a
 * negative figure, which is the signal a manager needs to act on.
 */
export async function getOnHand(
  tenantId: string, f: { itemId?: string; locationId?: string } = {},
): Promise<OnHandRow[]> {
  return withTenant(tenantId, async (tx) => {
    const where = [
      f.itemId ? eq(stockLedger.itemId, f.itemId) : undefined,
      f.locationId ? eq(stockLedger.locationId, f.locationId) : undefined,
    ].filter(Boolean);
    const rows = await tx.select({
      itemId: stockLedger.itemId,
      nameEn: inventoryItems.nameEn,
      nameAr: inventoryItems.nameAr,
      baseUom: inventoryItems.baseUom,
      locationId: stockLedger.locationId,
      locationName: storageLocations.name,
      onHand: sql<string>`COALESCE(SUM(${stockLedger.qty}), 0)`,
    }).from(stockLedger)
      .innerJoin(inventoryItems, eq(inventoryItems.id, stockLedger.itemId))
      .innerJoin(storageLocations, eq(storageLocations.id, stockLedger.locationId))
      .where(where.length ? and(...where) : undefined)
      .groupBy(
        stockLedger.itemId, inventoryItems.nameEn, inventoryItems.nameAr,
        inventoryItems.baseUom, stockLedger.locationId, storageLocations.name,
      )
      .orderBy(inventoryItems.nameEn);
    return rows.map((r) => ({ ...r, onHand: Number(r.onHand) }));
  });
}

/** The remaining lots behind an item's on-hand, in the order FIFO will consume them. */
export async function listLots(
  tenantId: string, f: { itemId?: string; locationId?: string; includeDepleted?: boolean; limit?: number } = {},
): Promise<InventoryLot[]> {
  return withTenant(tenantId, (tx) => {
    const where = [
      f.itemId ? eq(inventoryLots.itemId, f.itemId) : undefined,
      f.locationId ? eq(inventoryLots.locationId, f.locationId) : undefined,
      f.includeDepleted ? undefined : sql`${inventoryLots.qtyRemaining} > 0`,
    ].filter(Boolean);
    return tx.select().from(inventoryLots)
      .where(where.length ? and(...where) : undefined)
      .orderBy(inventoryLots.receivedAt)
      .limit(clamp(f.limit));
  });
}

export async function listCounts(
  tenantId: string, f: { status?: StockCount["status"]; limit?: number } = {},
): Promise<StockCount[]> {
  return withTenant(tenantId, (tx) => tx.select().from(stockCounts)
    .where(f.status ? eq(stockCounts.status, f.status) : undefined)
    .orderBy(desc(stockCounts.startedAt))
    .limit(clamp(f.limit)));
}
