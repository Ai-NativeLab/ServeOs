import { describe, it, expect } from "vitest";
import { withTenant } from "@/db/with-tenant";
import { authorize, UnauthorizedError } from "@/server/rbac/authorize";
import { listItems, getOnHand, listLots, listCounts } from "./read";
import { adjustStock } from "./service";
import { seedInventoryTenant, seedItem, seedLocation, stockLot } from "./test-helpers";

describe("inventory reads", () => {
  it("lists active items by name and filters by kind", async () => {
    const { tenantId } = await seedInventoryTenant();
    await seedItem(tenantId, { nameEn: "Zucchini", kind: "ingredient" });
    await seedItem(tenantId, { nameEn: "Apron", kind: "raw_material" });
    await seedItem(tenantId, { nameEn: "Cola", kind: "finished_good" });

    const all = await listItems(tenantId);
    expect(all.map((i) => i.nameEn)).toEqual(["Apron", "Cola", "Zucchini"]); // name order

    const goods = await listItems(tenantId, { kind: "finished_good" });
    expect(goods.map((i) => i.nameEn)).toEqual(["Cola"]);
  });

  it("reports on-hand per item AND location, not one collapsed total", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const back = await seedLocation(tenantId, branchId, "back_of_house");
    const itemId = await seedItem(tenantId, { nameEn: "Flour", baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: kitchen, baseQty: 300, uom: "g" });
    await stockLot(tenantId, { itemId, locationId: back, baseQty: 700, uom: "g" });

    const rows = await getOnHand(tenantId, { itemId });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.onHand, 0)).toBe(1000);
    expect(new Set(rows.map((r) => r.locationId))).toEqual(new Set([kitchen, back]));

    const justKitchen = await getOnHand(tenantId, { itemId, locationId: kitchen });
    expect(justKitchen).toHaveLength(1);
    expect(justKitchen[0].onHand).toBe(300);
  });

  it("surfaces a negative on-hand rather than clamping it — an oversold kitchen must be visible", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { nameEn: "Basil", baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: kitchen, baseQty: 5, uom: "g" });
    await withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId: kitchen, baseQty: -8, uom: "g", note: "oversold",
    }));

    const [row] = await getOnHand(tenantId, { itemId });
    expect(row.onHand).toBe(-3);
  });

  it("lists only lots with stock left, oldest first (the order FIFO consumes them)", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const kitchen = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    const older = await stockLot(tenantId, {
      itemId, locationId: kitchen, baseQty: 10, uom: "g", receivedAt: new Date("2026-01-01"),
    });
    const newer = await stockLot(tenantId, {
      itemId, locationId: kitchen, baseQty: 10, uom: "g", receivedAt: new Date("2026-05-01"),
    });

    expect((await listLots(tenantId, { itemId })).map((l) => l.id)).toEqual([older, newer]);

    // Deplete the older lot; it should drop out unless explicitly requested.
    await withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId: kitchen, baseQty: -10, uom: "g", lotId: older,
    }));
    expect((await listLots(tenantId, { itemId })).map((l) => l.id)).toEqual([newer]);
    expect((await listLots(tenantId, { itemId, includeDepleted: true })).map((l) => l.id)).toEqual([older, newer]);
  });

  it("hides another tenant's items, on-hand and lots (RLS)", async () => {
    const a = await seedInventoryTenant();
    const b = await seedInventoryTenant();
    const locA = await seedLocation(a.tenantId, a.branchId);
    const itemA = await seedItem(a.tenantId, { nameEn: "Secret Sauce", baseUom: "g" });
    await stockLot(a.tenantId, { itemId: itemA, locationId: locA, baseQty: 42, uom: "g" });

    expect(await listItems(b.tenantId)).toHaveLength(0);
    expect(await getOnHand(b.tenantId, { itemId: itemA })).toHaveLength(0);
    expect(await listLots(b.tenantId, { itemId: itemA })).toHaveLength(0);
    expect(await listCounts(b.tenantId)).toHaveLength(0);
  });

  it("staff may view and count but not manage — the assertion each route maps to 403", () => {
    expect(() => authorize(["staff"], "inventory:view")).not.toThrow();
    expect(() => authorize(["staff"], "inventory:count")).not.toThrow();
    expect(() => authorize(["staff"], "inventory:manage")).toThrow(UnauthorizedError);

    for (const perm of ["inventory:view", "inventory:count", "inventory:manage"] as const) {
      expect(() => authorize(["manager"], perm)).not.toThrow();
      expect(() => authorize(["owner"], perm)).not.toThrow();
    }
  });
});
