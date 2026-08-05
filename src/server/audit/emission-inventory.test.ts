import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import type { AuditActorInput } from "./service";
import { adjustStock, transferStock, commitCount, deductForOrderLine } from "@/server/inventory/service";
import { stockCounts, stockCountLines } from "@/server/inventory/schema";
import { seedInventoryTenant, seedItem, seedLocation, stockLot } from "@/server/inventory/test-helpers";

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}

let n = 0;
async function setup(vertical: "restaurant" | "retail" = "restaurant") {
  const { tenantId, branchId } = await seedInventoryTenant(vertical);
  const [u] = await db.insert(users).values({
    tenantId, name: "Owner", email: `inv-audit-${Date.now()}-${n++}@x.com`, status: "active",
  }).returning();
  const audit: AuditActorInput = {
    actorUserId: u.id, actorType: "user", roleKey: "owner",
    fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
  };
  return { tenantId, branchId, userId: u.id, audit };
}

describe("audit emission — inventory", () => {
  it("adjustStock emits inventory.adjust and keeps a valid chain", async () => {
    const { tenantId, branchId, audit } = await setup();
    const locationId = await seedLocation(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId, baseQty: 100, uom: "g" });

    await withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId, baseQty: -10, uom: "g", note: "recount", audit,
    }));

    const events = await eventsFor(tenantId, "inventory.adjust");
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("inventory_item");
    expect(events[0].entityId).toBe(itemId);
    expect(events[0].actorUserId).toBe(audit.actorUserId);
    expect((events[0].metadata as { locationId: string }).locationId).toBe(locationId);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("waste is audited as its own action, not as an adjustment", async () => {
    const { tenantId, branchId, audit } = await setup();
    const locationId = await seedLocation(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId, baseQty: 100, uom: "g" });

    await withTenant(tenantId, (tx) => adjustStock(tx, {
      tenantId, itemId, locationId, baseQty: -5, uom: "g", type: "waste", note: "spoiled", audit,
    }));

    // Shrinkage must be distinguishable from a recount in the audit trail.
    expect(await eventsFor(tenantId, "inventory.waste")).toHaveLength(1);
    expect(await eventsFor(tenantId, "inventory.adjust")).toHaveLength(0);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("transferStock emits inventory.transfer naming both locations", async () => {
    const { tenantId, branchId, audit } = await setup();
    const from = await seedLocation(tenantId, branchId, "back_of_house");
    const to = await seedLocation(tenantId, branchId, "kitchen");
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId: from, baseQty: 100, uom: "g" });

    await withTenant(tenantId, (tx) => transferStock(tx, {
      tenantId, itemId, fromLocationId: from, toLocationId: to, baseQty: 40, uom: "g", audit,
    }));

    const [event] = await eventsFor(tenantId, "inventory.transfer");
    expect(event).toBeTruthy();
    const meta = event.metadata as { fromLocationId: string; toLocationId: string };
    expect(meta.fromLocationId).toBe(from);
    expect(meta.toLocationId).toBe(to);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("commitCount emits inventory.count.commit with the variance-line count", async () => {
    const { tenantId, branchId, userId, audit } = await setup();
    const locationId = await seedLocation(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    await stockLot(tenantId, { itemId, locationId, baseQty: 10, uom: "g" });

    await withTenant(tenantId, async (tx) => {
      const [count] = await tx.insert(stockCounts).values({
        tenantId, branchId, locationId, startedByUserId: userId,
      }).returning();
      await tx.insert(stockCountLines).values({
        tenantId, countId: count.id, itemId, systemQty: "10.000", countedQty: "8.000", varianceQty: "-2.000",
      });
      await commitCount(tx, tenantId, count.id, userId, audit);
    });

    const [event] = await eventsFor(tenantId, "inventory.count.commit");
    expect(event).toBeTruthy();
    expect(event.entityType).toBe("stock_count");
    expect((event.metadata as { varianceLines: number }).varianceLines).toBe(1);
    expect((await verifyChain(tenantId)).ok).toBe(true);
  });

  it("a sale's deduction emits no inventory event of its own — order.placed already covers it", async () => {
    const { tenantId, branchId } = await setup("retail");
    const locationId = await seedLocation(tenantId, branchId, "retail");
    const itemId = await seedItem(tenantId, { baseUom: "each", kind: "finished_good" });
    await stockLot(tenantId, { itemId, locationId, baseQty: 10, uom: "each" });

    const productId = await withTenant(tenantId, async (tx) => {
      const cat = await tx.execute<{ id: string }>(sql`
        INSERT INTO categories (tenant_id, name_en, name_ar) VALUES (${tenantId}, 'C', 'ج') RETURNING id`);
      const prod = await tx.execute<{ id: string }>(sql`
        INSERT INTO products (tenant_id, category_id, name_en, name_ar, base_price)
        VALUES (${tenantId}, ${cat.rows[0].id}, 'P', 'ب', '10.00') RETURNING id`);
      await tx.execute(sql`
        INSERT INTO product_inventory_links (tenant_id, product_id, link_type, item_id)
        VALUES (${tenantId}, ${prod.rows[0].id}, 'finished_good', ${itemId})`);
      return prod.rows[0].id;
    });

    await withTenant(tenantId, (tx) => deductForOrderLine(tx, {
      tenantId, branchId, productId, variantId: null, quantity: 2,
      orderItemId: "00000000-0000-0000-0000-0000000000d1",
      allowNegative: false, byUserId: null, productNameEn: "P", productNameAr: "ب",
    }));

    // The ledger row IS the record of the deduction; duplicating it as an audit
    // event would double-count every sale in the trail.
    expect(await eventsFor(tenantId, "inventory.adjust")).toHaveLength(0);
    expect(await eventsFor(tenantId, "inventory.deduct")).toHaveLength(0);
  });
});
