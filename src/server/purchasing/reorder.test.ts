import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem, seedLocation } from "@/server/inventory/test-helpers";
import { inventoryLots } from "@/server/inventory/schema";
import { verifyChain } from "@/server/audit/verifier";
import { auditEvents } from "@/server/audit/schema";
import { notifications } from "@/server/notifications/schema";
import { getLowStock } from "@/server/analytics/service";
import { purchaseOrders, purchaseOrderLines } from "./schema";
import type { PurchasingActor } from "./suppliers";
import { createSupplier, upsertSupplierItem } from "./suppliers";
import { reorderRules } from "./reorder-schema";
import { upsertReorderRule, listReorderRules, checkReorder } from "./reorder";
import { createDraftPo, updateDraftPo } from "./service";
import { InvalidPoInputError } from "./errors";

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

  it("rejects a preferredSupplierId from another tenant (I13)", async () => {
    const { actor, itemAtPoint, locationId } = await seedReorderContext();
    const other = await seedReorderContext();
    await expect(upsertReorderRule(actor, {
      itemId: itemAtPoint, locationId, reorderPoint: 20, reorderQty: 50,
      preferredSupplierId: other.supplierId,
    })).rejects.toThrow(InvalidPoInputError);
  });

  it("merges a different low item into the supplier's open draft instead of dropping it", async () => {
    const { tenantId, actor, supplierId, itemAtPoint, itemNoLots, locationId } = await seedReorderContext();
    await stock(tenantId, itemAtPoint, locationId, 5);
    await stock(tenantId, itemNoLots, locationId, 5);
    await upsertSupplierItem(actor, { supplierId, itemId: itemAtPoint, lastUnitCost: 2 });
    await upsertSupplierItem(actor, { supplierId, itemId: itemNoLots, lastUnitCost: 3 });
    for (const itemId of [itemAtPoint, itemNoLots]) {
      await upsertReorderRule(actor, {
        itemId, locationId, reorderPoint: 20, reorderQty: 10, preferredSupplierId: supplierId,
      });
    }

    // Run 1: both items below point → one draft with BOTH lines.
    const run1 = await checkReorder(actor);
    expect(run1.draftsCreated).toBe(1);
    let [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    let poLines = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, po!.id)));
    expect(poLines).toHaveLength(2);

    // Clear the debounce clock so a second run re-evaluates, then back the rule
    // out of existence for itemAtPoint (deleted item cascades the rule) and add
    // a NEW item for the same supplier. Run 2 must MERGE the new item into the
    // open draft, not create a duplicate draft nor drop the new item.
    await withTenant(tenantId, (tx) => tx.update(reorderRules).set({ lastAlertedAt: null }));
    const newItem = await seedItem(tenantId, { nameEn: "New Low", baseUom: "g" });
    await stock(tenantId, newItem, locationId, 1);
    await upsertSupplierItem(actor, { supplierId, itemId: newItem, lastUnitCost: 4 });
    await upsertReorderRule(actor, {
      itemId: newItem, locationId, reorderPoint: 20, reorderQty: 10, preferredSupplierId: supplierId,
    });

    const run2 = await checkReorder(actor);
    expect(run2.draftsCreated).toBe(0); // merged, not a new draft

    const pos = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos).toHaveLength(1); // still one PO
    po = pos[0]!;
    poLines = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, po.id)));
    const lineItems = poLines.map((l) => l.itemId).sort();
    expect(lineItems).toContain(itemAtPoint); // existing line untouched
    expect(lineItems).toContain(newItem); // new item MERGED, not dropped
    expect(lineItems).toHaveLength(3);
    // Total = 10×2 + 10×3 + 10×4 = 90.
    expect(po.total).toBe("90.00");
  });

  it("audit-attributes reorder drafts by the actor: system for the cron, user for a manager", async () => {
    const { tenantId, actor, supplierId, itemAtPoint, locationId } = await seedReorderContext();
    await stock(tenantId, itemAtPoint, locationId, 5);
    await upsertSupplierItem(actor, { supplierId, itemId: itemAtPoint, lastUnitCost: 2 });
    await upsertReorderRule(actor, {
      itemId: itemAtPoint, locationId, reorderPoint: 20, reorderQty: 10, preferredSupplierId: supplierId,
    });

    // A manager-driven sweep (route) is a real user → actorType "user".
    await checkReorder(actor);
    let events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "po.created"), eq(auditEvents.actorType, "user"))));
    expect(events).toHaveLength(1);

    // Clear the debounce and drop the first draft so the system run creates a
    // fresh PO atomically attributed as a machine write.
    await withTenant(tenantId, (tx) => tx.update(reorderRules).set({ lastAlertedAt: null }));
    await withTenant(tenantId, async (tx) => {
      const [first] = await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).limit(1);
      if (first) await tx.delete(purchaseOrders).where(eq(purchaseOrders.id, first.id));
    });
    await checkReorder({ ...actor, actorType: "system" });
    events = await withTenant(tenantId, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, "po.created"), eq(auditEvents.actorType, "system"))));
    expect(events).toHaveLength(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });
});

describe("reorder regression pins", () => {
  it("prices an auto-draft from the PO's OWN supplier, not another supplier's row", async () => {
    // supplier_items is unique on (supplier_id, item_id), so two suppliers may
    // legitimately price the same item. An unscoped lookup builds its price map
    // across ALL suppliers and can mail a competitor's rate.
    //
    // Deterministic by construction: the PREFERRED supplier has no price row at
    // all, and a rival does. Scoped -> no price found -> 0.00. Unscoped -> the
    // rival's 999 leaks in. This does not depend on which row the driver
    // happens to return last, which an equal-and-opposite pair of prices would.
    const { tenantId, actor, itemAtPoint, locationId } = await seedReorderContext();
    const preferred = await createSupplier(actor, { name: "AAA (no price on file)" });
    const rival = await createSupplier(actor, { name: "BBB" });
    await upsertSupplierItem(actor, { supplierId: rival, itemId: itemAtPoint, lastUnitCost: 999 });

    await upsertReorderRule(actor, {
      itemId: itemAtPoint, locationId,
      reorderPoint: 20, reorderQty: 10, preferredSupplierId: preferred,
    });
    await stock(tenantId, itemAtPoint, locationId, 5);

    const run = await checkReorder(actor);
    expect(run.draftsCreated).toBe(1);

    const [po] = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id)));
    expect(po.supplierId).toBe(preferred);
    expect(line.unitCost).toBe("0.00");   // the rival's 999.00 must not leak in
    expect(po.total).toBe("0.00");
  });

  it("takes the tenant advisory lock BEFORE any PO row lock (deadlock ordering)", async () => {
    // The cycle this prevents: checkReorder takes the per-tenant advisory key
    // first and then UPDATEs an open draft, while a PO writer takes FOR UPDATE
    // on that same row and only reaches the key via recordAuditEvent. Racing
    // them deadlocked (40P01) on 12 of 12 rounds before `lockTenant` was applied
    // to both sides.
    //
    // Racing real functions is timing-dependent, so this pins the ORDERING
    // instead: hold the advisory key on a separate connection, start a PO
    // writer, and then touch the PO row. If the writer takes the advisory key
    // first it is parked there holding no row locks, so our UPDATE sails
    // through. If it grabbed the row first, the two of us are a cycle and
    // Postgres kills one with 40P01.
    const { tenantId, branchId, actor, supplierId, itemAtPoint } = await seedReorderContext();
    const { poId } = await createDraftPo(actor, {
      supplierId, branchId,
      lines: [{ itemId: itemAtPoint, qtyOrdered: 1, uom: "g", unitCost: 1 }],
    });

    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await holder.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [tenantId]);

      // Starts, then parks on the advisory key we are holding.
      const writer = updateDraftPo(actor, poId, {
        supplierId, branchId,
        lines: [{ itemId: itemAtPoint, qtyOrdered: 2, uom: "g", unitCost: 1 }],
      });
      await new Promise((r) => setTimeout(r, 300));

      // Deadlocks here if the writer locked the row before the advisory key.
      await holder.query("UPDATE purchase_orders SET total = total WHERE id = $1", [poId]);
      await holder.query("COMMIT");
      await writer;
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }

    const [line] = await withTenant(tenantId, (tx) =>
      tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)));
    expect(line?.qtyOrdered).toBe("2.000");
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });
});
