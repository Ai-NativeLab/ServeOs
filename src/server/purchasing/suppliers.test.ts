import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { suppliers, supplierItems } from "./schema";
import { createSupplier, updateSupplier, upsertSupplierItem, listSuppliers } from "./suppliers";

async function seedActor(tenantId: string, branchId: string) {
  const [user] = await db.insert(users).values({
    tenantId, name: "Owner", email: `own-${crypto.randomUUID().slice(0, 8)}@x.com`, status: "active",
  }).returning({ id: users.id });
  return { tenantId, branchId, actorUserId: user.id, vertical: "restaurant" as const };
}

describe("supplier CRUD", () => {
  it("createSupplier persists and listSuppliers returns it", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);

    const supplierId = await createSupplier(actor, { name: "Al-Nile Foods", email: "sales@alnile.example" });

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(suppliers).where(eq(suppliers.id, supplierId)));
    expect(row?.name).toBe("Al-Nile Foods");
    expect(row?.email).toBe("sales@alnile.example");

    const listed = await listSuppliers(tenantId);
    expect(listed.map((s) => s.id)).toContain(supplierId);
  });

  it("updateSupplier edits an existing supplier", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);

    const supplierId = await createSupplier(actor, { name: "Old Name" });
    await updateSupplier(actor, supplierId, { name: "New Name", isActive: false });

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(suppliers).where(eq(suppliers.id, supplierId)));
    expect(row?.name).toBe("New Name");
    expect(row?.isActive).toBe(false);
  });

  it("upsertSupplierItem is unique per (supplierId, itemId): the second upsert updates lastUnitCost", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });
    const supplierId = await createSupplier(actor, { name: "S" });

    await upsertSupplierItem(actor, { supplierId, itemId, supplierSku: "SKU1", lastUnitCost: 10 });
    await upsertSupplierItem(actor, { supplierId, itemId, supplierSku: "SKU1", lastUnitCost: 12 });

    const rows = await withTenant(tenantId, (tx) => tx.select().from(supplierItems).where(eq(supplierItems.supplierId, supplierId)));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.lastUnitCost)).toBe(12);
  });

  it("tenant B never sees tenant A's suppliers (RLS)", async () => {
    const a = await seedInventoryTenant();
    const b = await seedInventoryTenant();
    const actorA = await seedActor(a.tenantId, a.branchId);
    const supplierId = await createSupplier(actorA, { name: "A-only" });

    const bListed = await listSuppliers(b.tenantId);
    expect(bListed.map((s) => s.id)).not.toContain(supplierId);

    // Direct read as tenant B also sees nothing.
    const bRows = await withTenant(b.tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT COUNT(*) AS n FROM suppliers WHERE name = 'A-only'`));
    expect(Number(bRows.rows[0]?.n)).toBe(0);
  });
});
