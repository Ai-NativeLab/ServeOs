import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { stockLedger, inventoryLots, stockCountLines } from "./schema";
import {
  onHand, adjustStock, transferStock, commitCount, addCountLines, deductForOrderLine, reverseOrderDeductions,
  getOrCreateDefaultLocation,
} from "./service";
import { seedInventoryTenant, seedItem, seedLocation, stockLot, seedRecipeProduct } from "./test-helpers";
import { OutOfStockError, DimensionalUomError, InventoryConfigError } from "./errors";

const deductArgs = (tenantId: string, branchId: string, over: Partial<Parameters<typeof deductForOrderLine>[1]> = {}) => ({
  tenantId, branchId, productId: "00000000-0000-0000-0000-000000000000", variantId: null,
  quantity: 1, orderItemId: "00000000-0000-0000-0000-000000000001", allowNegative: false,
  byUserId: null, productNameEn: "P", productNameAr: "ب", ...over,
});

async function ledgerRows(tenantId: string, itemId: string) {
  return withTenant(tenantId, (tx) => tx.select().from(stockLedger).where(eq(stockLedger.itemId, itemId)));
}

describe("inventory ledger", () => {
  it("on-hand is the sum of the ledger, not the lot cache", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const locationId = await seedLocation(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId, baseQty: 10, uom: "g" });

    await withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId, baseQty: -3, uom: "g", note: "spillage",
    }));

    expect(await onHand(tenantId, itemId, locationId)).toBe(7);
  });

  it("receiveStock creates a lot whose qtyRemaining equals the received base qty", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const locationId = await seedLocation(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    const lotId = await stockLot(tenantId, { itemId, locationId, baseQty: 250, uom: "g" });

    const [lot] = await withTenant(tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.id, lotId)));
    expect(Number(lot.qtyReceived)).toBe(250);
    expect(Number(lot.qtyRemaining)).toBe(250);
    expect(await onHand(tenantId, itemId, locationId)).toBe(250);
  });

  it("transferStock writes two balanced rows: -q at source, +q at destination", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const back = await seedLocation(tenantId, branchId, "back_of_house");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: back, baseQty: 100, uom: "g" });

    await withTenant(tenantId, (tx) => transferStock(tx, {
      tenantId, itemId, fromLocationId: back, toLocationId: kitchen, baseQty: 40, uom: "g",
    }));

    expect(await onHand(tenantId, itemId, back)).toBe(60);
    expect(await onHand(tenantId, itemId, kitchen)).toBe(40);

    // A transfer must net to zero across the tenant — it moves stock, not creates it.
    const rows = await ledgerRows(tenantId, itemId);
    const transfers = rows.filter((r) => r.type === "transfer");
    expect(transfers).toHaveLength(2);
    expect(transfers.reduce((s, r) => s + Number(r.qty), 0)).toBe(0);
    expect(new Set(transfers.map((r) => r.refId)).size).toBe(1); // one group id
  });

  it("FIFO deducts the oldest lot first, spanning into the next when short", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    // A finished-goods link resolves to the branch's RETAIL shelf, so stock the
    // lots there — seeding a kitchen would test nothing but the shortfall path.
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    const older = await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 4, uom: "g", receivedAt: new Date("2026-01-01"),
    });
    const newer = await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 10, uom: "g", receivedAt: new Date("2026-06-01"),
    });

    // Deduct directly through the FIFO core by way of a finished-goods link.
    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, {
        productId, quantity: 6, allowNegative: false,
      }));
    });

    const lots = await withTenant(tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemId)));
    const byId = Object.fromEntries(lots.map((l) => [l.id, Number(l.qtyRemaining)]));
    expect(byId[older]).toBe(0);
    expect(byId[newer]).toBe(8);

    const deductions = (await ledgerRows(tenantId, itemId)).filter((r) => r.type === "sale_deduction");
    expect(deductions).toHaveLength(2);
    expect(deductions.reduce((s, r) => s + Number(r.qty), 0)).toBe(-6);
  });

  it("expiry-first: a perishable consumes the soonest-expiring lot before an older-received one", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "ml", isPerishable: true });
    // Both expiries are far future on purpose: this test is about ORDERING
    // among sellable lots. A fixture date that quietly slips into the past would
    // make the lot expired and silently turn this into a different test.
    // Received FIRST but expires LATER — FIFO would take this one; expiry-first must not.
    const oldReceivedLateExpiry = await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 5, uom: "ml",
      receivedAt: new Date("2026-01-01"), expiryAt: new Date("2099-12-31"),
    });
    const newReceivedSoonExpiry = await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 5, uom: "ml",
      receivedAt: new Date("2026-06-01"), expiryAt: new Date("2099-01-01"),
    });

    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 5 }));
    });

    const lots = await withTenant(tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemId)));
    const byId = Object.fromEntries(lots.map((l) => [l.id, Number(l.qtyRemaining)]));
    expect(byId[newReceivedSoonExpiry]).toBe(0);
    expect(byId[oldReceivedLateExpiry]).toBe(5);
  });

  it("an expired lot is never sold — FIFO skips it and takes a fresh lot instead", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "ml", isPerishable: true });
    // Expired yesterday. Ordering alone (expiry ASC) would hand this out FIRST,
    // so only an explicit exclusion keeps it out of the sale.
    const expired = await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 10, uom: "ml",
      receivedAt: new Date("2026-01-01"), expiryAt: new Date("2026-08-04"),
    });
    const fresh = await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 10, uom: "ml",
      receivedAt: new Date("2026-07-01"), expiryAt: new Date("2027-01-01"),
    });

    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 6 }));
    });

    const lots = await withTenant(tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.itemId, itemId)));
    const byId = Object.fromEntries(lots.map((l) => [l.id, Number(l.qtyRemaining)]));
    expect(byId[expired]).toBe(10); // untouched
    expect(byId[fresh]).toBe(4);
    // The expired stock still counts as on hand — it exists, it just is not
    // sellable — so it stays visible until someone writes it off as waste.
    expect(await onHand(tenantId, itemId, shelf)).toBe(14);
  });

  it("a retail sale is refused when the only stock left is expired", async () => {
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "ml", kind: "finished_good", isPerishable: true });
    await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 10, uom: "ml", expiryAt: new Date("2026-08-04"),
    });

    await expect(withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 1 }));
    })).rejects.toThrow(OutOfStockError);
  });

  it("a cancel whose lot expired meanwhile returns the stock but does not put it back on sale", async () => {
    // This is the spec's "depleted/expired lot → flagged for review" outcome.
    // It needs no separate review lot: the quantity goes back to its original
    // cost layer, and the expiry exclusion keeps it from being sold, so it sits
    // visible on hand until someone writes it off.
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good", isPerishable: true });
    const lotId = await stockLot(tenantId, {
      itemId, locationId: shelf, baseQty: 10, uom: "each", expiryAt: new Date("2099-01-01"),
    });

    const orderItemId = "00000000-0000-0000-0000-0000000000f9";
    const productId = await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 4, orderItemId }));
      return productId;
    });
    expect(await onHand(tenantId, itemId, shelf)).toBe(6);

    // The lot expires while the order is outstanding.
    await withTenant(tenantId, (tx) => tx.update(inventoryLots)
      .set({ expiryAt: new Date("2026-08-04") }).where(eq(inventoryLots.id, lotId)));

    await withTenant(tenantId, (tx) => reverseOrderDeductions(tx, {
      tenantId, orderId: "unused", orderItemIds: [orderItemId],
    }));

    // Returned to its own lot, and countable...
    expect(await onHand(tenantId, itemId, shelf)).toBe(10);
    const [lot] = await withTenant(tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.id, lotId)));
    expect(Number(lot.qtyRemaining)).toBe(10);

    // ...but not sellable, so expired goods cannot go back out of the door.
    await expect(withTenant(tenantId, (tx) => deductForOrderLine(tx, deductArgs(tenantId, branchId, {
      productId, quantity: 1, orderItemId: "00000000-0000-0000-0000-0000000000fa",
    })))).rejects.toThrow(OutOfStockError);
  });

  it("retail blocks on a shortfall: OutOfStockError and no deduction rows", async () => {
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good" });
    await stockLot(tenantId, { itemId, locationId: shelf, baseQty: 1, uom: "each" });

    await expect(withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, {
        productId, quantity: 3, allowNegative: false,
      }));
    })).rejects.toThrow(OutOfStockError);

    // The whole transaction rolled back, so on-hand is untouched.
    expect(await onHand(tenantId, itemId, shelf)).toBe(1);
  });

  it("an oversell completes, drives on-hand negative, and raises a low_stock notification", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: shelf, baseQty: 2, uom: "g" });

    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, {
        productId, quantity: 5, allowNegative: true,
      }));
    });

    // 2 taken from the lot, 3 recorded as a lot-less shortfall.
    expect(await onHand(tenantId, itemId, shelf)).toBe(-3);
    const shortfall = (await ledgerRows(tenantId, itemId))
      .filter((r) => r.type === "sale_deduction" && r.lotId === null);
    expect(shortfall).toHaveLength(1);
    expect(Number(shortfall[0].qty)).toBe(-3);

    const notes = await withTenant(tenantId, (tx) =>
      tx.execute<{ type: string }>(sql`SELECT type FROM notifications WHERE entity_id = ${itemId}`));
    expect(notes.rows.map((r) => r.type)).toContain("low_stock");
  });

  it("a recipe deducts every component from the kitchen, scaled by sold qty, yield and waste", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const productId = await withTenant(tenantId, async (tx) => {
      const cat = await tx.execute<{ id: string }>(sql`
        INSERT INTO categories (tenant_id, name_en, name_ar) VALUES (${tenantId}, 'C', 'ج') RETURNING id`);
      const prod = await tx.execute<{ id: string }>(sql`
        INSERT INTO products (tenant_id, category_id, name_en, name_ar, base_price)
        VALUES (${tenantId}, ${cat.rows[0].id}, 'Margherita', 'مارجريتا', '120.00') RETURNING id`);
      return prod.rows[0].id;
    });

    // One batch yields 2 pizzas. Cheese carries 10% waste; dough none.
    const { locationId, itemIds } = await seedRecipeProduct(tenantId, {
      branchId, productId, yieldQty: "2",
      components: [
        { nameEn: "Dough", qty: "200", uom: "g", onHand: 1000 },
        { nameEn: "Cheese", qty: "100", uom: "g", wastePct: "10", onHand: 1000 },
      ],
    });
    const [doughId, cheeseId] = itemIds;

    // Sell 3 pizzas from a 2-pizza batch: dough 200 * 3/2 = 300;
    // cheese 100 * 1.1 = 110 per batch, * 3/2 = 165.
    await withTenant(tenantId, (tx) => deductForOrderLine(tx, deductArgs(tenantId, branchId, {
      productId, quantity: 3, allowNegative: true,
    })));

    expect(await onHand(tenantId, doughId, locationId)).toBe(700);
    expect(await onHand(tenantId, cheeseId, locationId)).toBe(835);
  });

  it("an unlinked sellable deducts nothing — the untracked passthrough survives", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await withTenant(tenantId, (tx) => deductForOrderLine(tx, deductArgs(tenantId, branchId, {
      productId: "00000000-0000-0000-0000-0000000000aa", quantity: 99,
    })));
    expect(await ledgerRows(tenantId, itemId)).toHaveLength(0);
  });

  it("reverseOrderDeductions restores the exact lot and is idempotent", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    const lotId = await stockLot(tenantId, { itemId, locationId: shelf, baseQty: 10, uom: "g" });

    const orderItemId = "00000000-0000-0000-0000-0000000000f1";
    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 4, orderItemId }));
    });
    expect(await onHand(tenantId, itemId, shelf)).toBe(6);

    await withTenant(tenantId, (tx) => reverseOrderDeductions(tx, {
      tenantId, orderId: "unused", orderItemIds: [orderItemId],
    }));
    expect(await onHand(tenantId, itemId, shelf)).toBe(10);
    const [lot] = await withTenant(tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.id, lotId)));
    expect(Number(lot.qtyRemaining)).toBe(10); // restored to the SAME lot

    // A re-entrant cancel must not double-restock.
    await withTenant(tenantId, (tx) => reverseOrderDeductions(tx, {
      tenantId, orderId: "unused", orderItemIds: [orderItemId],
    }));
    expect(await onHand(tenantId, itemId, shelf)).toBe(10);
  });

  it("commitCount writes one variance row per discrepant line and closes the count", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: kitchen, baseQty: 10, uom: "g" });

    const countId = await withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO stock_counts (tenant_id, branch_id, location_id) VALUES (${tenantId}, ${branchId}, ${kitchen}) RETURNING id`);
      const id = rows.rows[0].id;
      // Counted 8 where the system says 10 — a 2 g shrink.
      await tx.execute(sql`
        INSERT INTO stock_count_lines (tenant_id, count_id, item_id, system_qty, counted_qty, variance_qty)
        VALUES (${tenantId}, ${id}, ${itemId}, '10.000', '8.000', '-2.000')`);
      await commitCount(tx, tenantId, id, null);
      return id;
    });

    expect(await onHand(tenantId, itemId, kitchen)).toBe(8);
    const counts = (await ledgerRows(tenantId, itemId)).filter((r) => r.type === "count");
    expect(counts).toHaveLength(1);
    expect(Number(counts[0].qty)).toBe(-2);

    const status = await withTenant(tenantId, (tx) =>
      tx.execute<{ status: string }>(sql`SELECT status FROM stock_counts WHERE id = ${countId}`));
    expect(status.rows[0].status).toBe("committed");
  });

  it("two concurrent sales of a lot's last unit: exactly one wins", async () => {
    // The analog of the old flat-counter stock race. The guarded
    // UPDATE ... WHERE qty_remaining >= take is the serialization point: under
    // READ COMMITTED the loser re-evaluates against the committed row, finds
    // nothing left, and falls to the shortfall branch (retail → throws).
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good" });
    await stockLot(tenantId, { itemId, locationId: shelf, baseQty: 1, uom: "each" });

    const productId = await withTenant(tenantId, async (tx) => (await seedLinkedProduct(tx, tenantId, itemId)).productId);

    const sell = (orderItemId: string) => withTenant(tenantId, (tx) => deductForOrderLine(tx, deductArgs(tenantId, branchId, {
      productId, quantity: 1, orderItemId, allowNegative: false,
    })));

    const settled = await Promise.allSettled([
      sell("00000000-0000-0000-0000-00000000aa01"),
      sell("00000000-0000-0000-0000-00000000aa02"),
    ]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OutOfStockError);
    // Never oversold: the winner took the unit, the loser wrote nothing.
    expect(await onHand(tenantId, itemId, shelf)).toBe(0);
  });

  it("count lines snapshot system qty, and re-counting an item corrects rather than double-counts", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: kitchen, baseQty: 10, uom: "g" });

    const countId = await withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO stock_counts (tenant_id, branch_id, location_id)
        VALUES (${tenantId}, ${branchId}, ${kitchen}) RETURNING id`);
      const id = rows.rows[0].id;
      await addCountLines(tx, tenantId, id, [{ itemId, countedQty: 7 }]);
      // The counter miscounted and re-submits the same item.
      await addCountLines(tx, tenantId, id, [{ itemId, countedQty: 8 }]);
      return id;
    });

    const lines = await withTenant(tenantId, (tx) =>
      tx.select().from(stockCountLines).where(eq(stockCountLines.countId, countId)));
    expect(lines).toHaveLength(1); // corrected, not appended
    expect(Number(lines[0].countedQty)).toBe(8);
    expect(Number(lines[0].systemQty)).toBe(10);
    expect(Number(lines[0].varianceQty)).toBe(-2);

    await withTenant(tenantId, (tx) => commitCount(tx, tenantId, countId, null));
    expect(await onHand(tenantId, itemId, kitchen)).toBe(8);
  });

  it("refuses to add lines to a count that is already committed", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { baseUom: "g" });

    await expect(withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO stock_counts (tenant_id, branch_id, location_id)
        VALUES (${tenantId}, ${branchId}, ${kitchen}) RETURNING id`);
      const id = rows.rows[0].id;
      await commitCount(tx, tenantId, id, null);
      await addCountLines(tx, tenantId, id, [{ itemId, countedQty: 1 }]);
    })).rejects.toThrow(InventoryConfigError);
  });

  it("converts a caller's unit to the item's base unit instead of storing it verbatim", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const locationId = await seedLocation(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "g" });

    // 2 kg into a gram-based item is 2000 g, not 2.
    await stockLot(tenantId, { itemId, locationId, baseQty: 2, uom: "kg" });
    expect(await onHand(tenantId, itemId, locationId)).toBe(2000);

    await withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId, baseQty: -1, uom: "kg", note: "wrote off a kilo",
    }));
    expect(await onHand(tenantId, itemId, locationId)).toBe(1000);

    // And the row is labelled in base units, so summing qty blind stays correct.
    const rows = await ledgerRows(tenantId, itemId);
    expect(rows.every((r) => r.uom === "g")).toBe(true);
  });

  it("a transfer moves the lots too, so the destination can actually sell", async () => {
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const back = await seedLocation(tenantId, branchId, "back_of_house");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good" });
    await stockLot(tenantId, { itemId, locationId: back, baseQty: 10, uom: "each" });

    await withTenant(tenantId, (tx) => transferStock(tx, {
      tenantId, itemId, fromLocationId: back, toLocationId: shelf, baseQty: 4, uom: "each",
    }));

    expect(await onHand(tenantId, itemId, back)).toBe(6);
    expect(await onHand(tenantId, itemId, shelf)).toBe(4);

    // The destination has lots, so a sale succeeds rather than hitting a shelf
    // that reads 4 but has nothing FIFO can consume.
    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 4 }));
    });
    expect(await onHand(tenantId, itemId, shelf)).toBe(0);

    // And the source cannot still sell what it gave away.
    const sourceLots = await withTenant(tenantId, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.locationId, back)));
    expect(sourceLots.reduce((s, l) => s + Number(l.qtyRemaining), 0)).toBe(6);
  });

  it("refuses a transfer larger than the source holds", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const back = await seedLocation(tenantId, branchId, "back_of_house");
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: back, baseQty: 5, uom: "g" });

    await expect(withTenant(tenantId, (tx) => transferStock(tx, {
      tenantId, itemId, fromLocationId: back, toLocationId: kitchen, baseQty: 50, uom: "g",
    }))).rejects.toThrow(InventoryConfigError);
  });

  it("a positive adjustment creates a lot, so the stock it adds is actually sellable", async () => {
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good" });

    // No lots at all to begin with — the shelf is empty.
    await withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId: shelf, baseQty: 10, uom: "each", note: "found a box",
    }));
    expect(await onHand(tenantId, itemId, shelf)).toBe(10);

    // Previously this reported 10 on hand and then refused every sale.
    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 10 }));
    });
    expect(await onHand(tenantId, itemId, shelf)).toBe(0);
  });

  it("a count surplus is sellable and a count shortage draws down the lots", async () => {
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good" });
    await stockLot(tenantId, { itemId, locationId: shelf, baseQty: 5, uom: "each" });

    // Counted 8 where the system said 5 — a surplus of 3.
    await withTenant(tenantId, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO stock_counts (tenant_id, branch_id, location_id)
        VALUES (${tenantId}, ${branchId}, ${shelf}) RETURNING id`);
      await addCountLines(tx, tenantId, rows.rows[0].id, [{ itemId, countedQty: 8 }]);
      await commitCount(tx, tenantId, rows.rows[0].id, null);
    });
    expect(await onHand(tenantId, itemId, shelf)).toBe(8);

    // All 8 must be sellable, surplus included.
    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId);
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, { productId, quantity: 8 }));
    });
    expect(await onHand(tenantId, itemId, shelf)).toBe(0);
  });

  it("a variant with no link of its own falls back to the product's base link", async () => {
    const { tenantId, branchId } = await seedInventoryTenant("retail");
    const shelf = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good" });
    await stockLot(tenantId, { itemId, locationId: shelf, baseQty: 10, uom: "each" });

    await withTenant(tenantId, async (tx) => {
      const { productId } = await seedLinkedProduct(tx, tenantId, itemId); // base link, variantId NULL
      const v = await tx.execute<{ id: string }>(sql`
        INSERT INTO product_variants (tenant_id, product_id, name_en, name_ar, price)
        VALUES (${tenantId}, ${productId}, '35mm', '٣٥', '55') RETURNING id`);
      // Selling the VARIANT used to deduct nothing at all.
      await deductForOrderLine(tx, deductArgs(tenantId, branchId, {
        productId, variantId: v.rows[0].id, quantity: 3,
      }));
    });
    expect(await onHand(tenantId, itemId, shelf)).toBe(7);
  });

  it("the stock_ledger append-only trigger rejects UPDATE and DELETE", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: kitchen, baseQty: 1, uom: "g" });

    // drizzle wraps the driver error, so the trigger's message sits on the cause.
    const rejectionText = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
        return "NO ERROR RAISED";
      } catch (e) {
        const parts: string[] = [];
        for (let cur: unknown = e; cur instanceof Error; cur = (cur as { cause?: unknown }).cause) {
          parts.push(cur.message);
        }
        return parts.join(" | ");
      }
    };

    expect(await rejectionText(() => withTenant(tenantId, (tx) =>
      tx.execute(sql`UPDATE stock_ledger SET qty = '0' WHERE item_id = ${itemId}`)))).toMatch(/append-only/);
    expect(await rejectionText(() => withTenant(tenantId, (tx) =>
      tx.execute(sql`DELETE FROM stock_ledger WHERE item_id = ${itemId}`)))).toMatch(/append-only/);
  });

  it("rejects a sellable dimensional unit as an inventory unit", async () => {
    const { tenantId, branchId } = await seedInventoryTenant("timber");
    const locationId = await seedLocation(tenantId, branchId, "back_of_house");
    // m2 is a valid unit_of_measure (P4 sells by it) but is not stockable.
    const itemId = await seedItem(tenantId, { baseUom: "m2" as never });
    await expect(withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId, baseQty: 1, uom: "m2" as never,
    }))).rejects.toThrow(DimensionalUomError);
  });

  it("hides one tenant's ledger from another (RLS)", async () => {
    const a = await seedInventoryTenant();
    const b = await seedInventoryTenant();
    const locA = await seedLocation(a.tenantId, a.branchId);
    const itemA = await seedItem(a.tenantId, { baseUom: "g" });
    await stockLot(a.tenantId, { itemId: itemA, locationId: locA, baseQty: 10, uom: "g" });

    // Tenant B asking for A's item+location sees nothing, not A's 10 g.
    expect(await onHand(b.tenantId, itemA, locA)).toBe(0);
    const seenFromB = await withTenant(b.tenantId, (tx) =>
      tx.select().from(stockLedger).where(eq(stockLedger.itemId, itemA)));
    expect(seenFromB).toHaveLength(0);
  });

  it("provisions a branch's default location lazily rather than failing a sale", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const first = await withTenant(tenantId, (tx) => getOrCreateDefaultLocation(tx, tenantId, branchId, "retail"));
    const again = await withTenant(tenantId, (tx) => getOrCreateDefaultLocation(tx, tenantId, branchId, "retail"));
    expect(again.id).toBe(first.id); // created once, then reused
    expect(first.isDefault).toBe(true);
  });
});

/**
 * A minimal product wired to a finished-goods item, so the FIFO core can be
 * driven through the public resolver rather than reaching into private helpers.
 */
async function seedLinkedProduct(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0], tenantId: string, itemId: string,
): Promise<{ productId: string }> {
  const cat = await tx.execute<{ id: string }>(sql`
    INSERT INTO categories (tenant_id, name_en, name_ar) VALUES (${tenantId}, 'C', 'ج') RETURNING id`);
  const prod = await tx.execute<{ id: string }>(sql`
    INSERT INTO products (tenant_id, category_id, name_en, name_ar, base_price)
    VALUES (${tenantId}, ${cat.rows[0].id}, 'P', 'ب', '10.00') RETURNING id`);
  const productId = prod.rows[0].id;
  await tx.execute(sql`
    INSERT INTO product_inventory_links (tenant_id, product_id, link_type, item_id)
    VALUES (${tenantId}, ${productId}, 'finished_good', ${itemId})`);
  return { productId };
}
