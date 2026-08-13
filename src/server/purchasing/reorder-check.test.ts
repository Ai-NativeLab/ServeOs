import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem, seedLocation } from "@/server/inventory/test-helpers";
import { inventoryLots } from "@/server/inventory/schema";
import { checkTenantReorder, sweepAllTenants } from "../../../scripts/reorder-check";
import type { PurchasingActor } from "./suppliers";
import { createSupplier } from "./suppliers";
import { upsertReorderRule } from "./reorder";
import { purchaseOrders } from "./schema";

async function seedActor(tenantId: string, branchId: string): Promise<PurchasingActor> {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `own-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

/** Makes `tenantId` an ACTIVE tenant with an owner role/user so checkTenantReorder resolves it (it looks up roles.key='owner' + a branch). */
async function activate(tenantId: string): Promise<void> {
  const [r] = await db.insert(roles).values({ tenantId, key: "owner", name: "owner" }).returning({ id: roles.id });
  const [u] = await db.insert(users).values({
    tenantId, name: "O", email: `o-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  await db.insert(userRoles).values({ userId: u.id, roleId: r.id });
  await db.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId));
}

async function seedLowTenant() {
  const { tenantId, branchId } = await seedInventoryTenant();
  await activate(tenantId);
  const actor = await seedActor(tenantId, branchId);
  const supplierId = await createSupplier(actor, { name: "Preferred" });
  const itemId = await seedItem(tenantId, { baseUom: "g" });
  const locationId = await seedLocation(tenantId, branchId, "kitchen");
  await withTenant(tenantId, (tx) =>
    tx.insert(inventoryLots).values({
      tenantId, itemId, locationId,
      qtyReceived: "5", qtyRemaining: "5", unitCost: "1",
    }));
  await upsertReorderRule(actor, {
    itemId, locationId, reorderPoint: 20, reorderQty: 50, preferredSupplierId: supplierId,
  });
  return { tenantId, supplierId };
}

describe("reorder cron sweep", () => {
  it("drafts a PO per tenant when the sweep is invoked for that tenant directly", async () => {
    const { tenantId } = await seedLowTenant();

    const report = await checkTenantReorder(tenantId);
    expect(report.triggered).toBe(1);
    expect(report.draftsCreated).toBe(1);

    const pos = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos).toHaveLength(1);
    expect(pos[0]?.status).toBe("draft");
  });

  it("sweepAllTenants processes every tenant and one failure does not abort the rest", async () => {
    // Seed an active tenant that triggers, and one with no owner (so
    // checkTenantReorder returns zeros rather than throwing) — the sweep must
    // process both and count neither as a failure.
    const { tenantId } = await seedLowTenant();
    const blank = await seedInventoryTenant();
    await db.update(tenants).set({ status: "active" }).where(eq(tenants.id, blank.tenantId));

    const report = await sweepAllTenants();
    expect(report.failed).toBe(0);
    expect(report.processed).toBeGreaterThanOrEqual(2);

    const pos = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos).toHaveLength(1);
    const blankPos = await withTenant(blank.tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(blankPos).toHaveLength(0);

    // A second sweep is debounced: the triggered tenant drafts no duplicate PO.
    const second = await sweepAllTenants();
    expect(second.failed).toBe(0);
    const pos2 = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos2).toHaveLength(1);
  });
});