import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem, seedLocation } from "@/server/inventory/test-helpers";
import { inventoryLots } from "@/server/inventory/schema";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { notifications } from "@/server/notifications/schema";
import { getLowStock } from "@/server/analytics/service";
import { purchaseOrders } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { createSupplier, upsertSupplierItem } from "./suppliers";
import { reorderRules } from "./reorder-schema";
import { upsertReorderRule, listReorderRules, checkReorder } from "./reorder";

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `own-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

async function seedReorderContext() {
  const { tenantId, branchId } = await seedInventoryTenant();
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "Preferred" });
  const itemAtPoint = await seedItem(tenantId, { nameEn: "Flour", baseUom: "g" });
  const itemAbove = await seedItem(tenantId, { nameEn: "Sugar", baseUom: "g" });
  const itemNoLots = await seedItem(tenantId, { nameEn: "Salt", baseUom: "g" });
  const locationId = await seedLocation(tenantId, branchId, "kitchen");
  return { tenantId, branchId, actor, supplierId, itemAtPoint, itemAbove, itemNoLots, locationId };
}

async function stock(tenantId: string, itemId: string, locationId: string, baseQty: number) {
  await withTenant(tenantId, (tx) =>
    tx.insert(inventoryLots).values({
      tenantId, itemId, locationId,
      qtyReceived: String(baseQty), qtyRemaining: String(baseQty), unitCost: "1",
    }));
}

describe("reorder rules", () => {
  it("upsertReorderRule is unique per (item, location) and listReorderRules returns rows", async () => {
    const { tenantId, actor, itemAtPoint, locationId } = await seedReorderContext();

    await upsertReorderRule(actor, {
      itemId: itemAtPoint, locationId,
      reorderPoint: 20, reorderQty: 50, preferredSupplierId: null,
    });
    await upsertReorderRule(actor, {
      itemId: itemAtPoint, locationId,
      reorderPoint: 30, reorderQty: 60, preferredSupplierId: null,
    });

    const rules = await listReorderRules(tenantId);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.reorderPoint).toBe("30.000");
    expect(rules[0]?.reorderQty).toBe("60.000");

    const events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(eq(auditEvents.action, "reorder_rule.updated")));
    expect(events).toHaveLength(2);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("checkReorder notifies once per item at or below its point, never above, and zero-lots triggers", async () => {
    const { tenantId, actor, itemAtPoint, itemAbove, itemNoLots, locationId } = await seedReorderContext();
    await stock(tenantId, itemAtPoint, locationId, 15); // 15 ≤ 20 → trigger
    await stock(tenantId, itemAbove, locationId, 40); // 40 > 30 → no trigger
    for (const itemId of [itemAtPoint, itemAbove, itemNoLots]) {
      await upsertReorderRule(actor, {
        itemId, locationId, reorderPoint: itemId === itemAbove ? 30 : 20, reorderQty: 50,
      });
    }

    const res = await checkReorder(actor);
    expect(res.triggered).toBe(2);

    // Per-item low_stock event × owner+manager targets.
    const feed = await withTenant(tenantId, (tx) => tx.select().from(notifications)
      .where(eq(notifications.type, "low_stock")));
    expect(feed).toHaveLength(4);
    expect(feed.map((n) => n.targetRole).sort()).toEqual(["manager", "manager", "owner", "owner"]);
    expect(feed.every((n) => n.severity === "warning")).toBe(true);

    const lowStock = await getLowStock(tenantId);
    expect(lowStock.map((r) => r.itemId).sort()).toEqual([itemAtPoint, itemNoLots].sort());
  });

  it("is debounced: a second run within 24h does not re-notify; clearing lastAlertedAt does", async () => {
    const { tenantId, actor, itemAtPoint, locationId } = await seedReorderContext();
    await stock(tenantId, itemAtPoint, locationId, 5);
    await upsertReorderRule(actor, { itemId: itemAtPoint, locationId, reorderPoint: 20, reorderQty: 50 });

    await checkReorder(actor);
    const first = await checkReorder(actor);
    expect(first.triggered).toBe(1); // still low, but debounced
    const feed = await withTenant(tenantId, (tx) => tx.select().from(notifications)
      .where(eq(notifications.type, "low_stock")));
    expect(feed).toHaveLength(2); // one per target role, from the first run only

    await withTenant(tenantId, (tx) => tx.update(reorderRules).set({ lastAlertedAt: null }));
    await checkReorder(actor);
    const feed2 = await withTenant(tenantId, (tx) => tx.select().from(notifications)
      .where(eq(notifications.type, "low_stock")));
    expect(feed2).toHaveLength(4);
  });

  it("pre-fills one draft PO per preferred supplier at reorderQty × lastUnitCost; never sent", async () => {
    const { tenantId, branchId, actor, supplierId, itemAtPoint, itemNoLots, locationId } = await seedReorderContext();
    await stock(tenantId, itemAtPoint, locationId, 5);
    await stock(tenantId, itemNoLots, locationId, 5);
    await upsertSupplierItem(actor, { supplierId, itemId: itemAtPoint, lastUnitCost: 2 });
    // itemNoLots has no supplier item → unitCost falls back to 0.
    for (const itemId of [itemAtPoint, itemNoLots]) {
      await upsertReorderRule(actor, {
        itemId, locationId, reorderPoint: 20, reorderQty: 10, preferredSupplierId: supplierId,
      });
    }

    const res = await checkReorder(actor);
    expect(res.triggered).toBe(2);
    expect(res.draftsCreated).toBe(1);

    const pos = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos).toHaveLength(1);
    expect(pos[0]?.supplierId).toBe(supplierId);
    expect(pos[0]?.branchId).toBe(branchId);
    expect(pos[0]?.status).toBe("draft");
  });
});
