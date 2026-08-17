import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { auditChainHeads } from "@/server/audit/schema";
import { seedInventoryTenant, seedItem, seedLocation } from "@/server/inventory/test-helpers";
import { inventoryLots } from "@/server/inventory/schema";
import { checkTenantReorder, sweepAllTenants } from "../../../scripts/reorder-check";
import type { PurchasingActor } from "./suppliers";
import { createSupplier } from "./suppliers";
import { upsertReorderRule } from "./reorder";
import { purchaseOrders } from "./schema";

/**
 * Importing this script must NOT repoint DATABASE_URL. Its dotenv load carries
 * `override: true`, so unguarded it replaces the .env.test URL that vitest's
 * setup already installed with .env.local's — the developer's own database —
 * and the suite truncates every table before each test. backfill-inventory.ts
 * hit exactly this and carries the RUN_DIRECTLY guard plus the incident note.
 */
describe("reorder-check script import safety", () => {
  it("does not override the test DATABASE_URL on import", () => {
    const fromEnvTest = readFileSync(".env.test", "utf8")
      .split("\n").find((l) => l.startsWith("DATABASE_URL="))?.slice("DATABASE_URL=".length).trim();
    expect(fromEnvTest).toBeTruthy();
    expect(process.env.DATABASE_URL).toBe(fromEnvTest);
  });
});

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
    // Seed an active tenant that triggers, plus a tenant that actually THROWS.
    // requireCapability can't throw here (every vertical has the inventory
    // capability), so corrupt the audit chain instead: drop the head back to
    // seq=1 so the sweep's po.created computes seq=2, which ALREADY exists from
    // seedLowTenant's upsertReorderRule → unique (tenant, seq) violation. The
    // sweep must count the failure and still process the later tenants.
    const { tenantId } = await seedLowTenant();
    const throwing = await seedLowTenant();
    await withTenant(throwing.tenantId, (tx) =>
      tx.update(auditChainHeads).set({ seq: 1 }).where(eq(auditChainHeads.tenantId, throwing.tenantId)));

    const report = await sweepAllTenants();
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(report.processed).toBeGreaterThanOrEqual(2);

    // The throwing tenant's OWN draft must not exist (its po.created rolled back).
    const throwPos = await withTenant(throwing.tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(throwPos).toHaveLength(0);

    // The earlier good tenant still got its draft despite the sibling failure.
    const pos = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos).toHaveLength(1);

    const blank = await seedInventoryTenant();
    await db.update(tenants).set({ status: "active" }).where(eq(tenants.id, blank.tenantId));
    const blankPos = await withTenant(blank.tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(blankPos).toHaveLength(0);

    // A second sweep is debounced: the triggered tenant drafts no duplicate PO.
    const second = await sweepAllTenants();
    expect(second.failed).toBeGreaterThanOrEqual(1);
    const pos2 = await withTenant(tenantId, (tx) => tx.select().from(purchaseOrders));
    expect(pos2).toHaveLength(1);
  });
});