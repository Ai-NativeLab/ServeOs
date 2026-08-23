import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { seedInventoryTenant, seedItem } from "@/server/inventory/test-helpers";
import { suppliers, supplierItems } from "./schema";
import { createSupplier, updateSupplier, upsertSupplierItem, listSuppliers, listSupplierItems } from "./suppliers";
import { InvalidPoInputError } from "./errors";

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

  it("partial PATCH preserves fields the payload omitted — isActive-only and name-only probes (reviewer pin)", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);

    const supplierId = await createSupplier(actor, {
      name: "Full Co", email: "sales@x.com", phone: "+20100", contactName: "Ali", paymentTerms: "NET30",
    });

    // isActive-only: the mutable contact fields must survive untouched.
    await updateSupplier(actor, supplierId, { isActive: false });
    let [row] = await withTenant(tenantId, (tx) => tx.select().from(suppliers).where(eq(suppliers.id, supplierId)));
    expect(row?.isActive).toBe(false);
    expect(row?.email).toBe("sales@x.com");
    expect(row?.phone).toBe("+20100");
    expect(row?.contactName).toBe("Ali");
    expect(row?.paymentTerms).toBe("NET30");

    // name-only: same, nothing else clobbered.
    await updateSupplier(actor, supplierId, { name: "Renamed Co" });
    [row] = await withTenant(tenantId, (tx) => tx.select().from(suppliers).where(eq(suppliers.id, supplierId)));
    expect(row?.name).toBe("Renamed Co");
    expect(row?.email).toBe("sales@x.com");
    expect(row?.phone).toBe("+20100");
    expect(row?.contactName).toBe("Ali");
    expect(row?.paymentTerms).toBe("NET30");
    expect(row?.isActive).toBe(false);
  });

  it("upsertSupplierItem rejects a non-finite or negative lastUnitCost and persists nothing", async () => {
    // `unitRate` is String(n), and Postgres numeric ACCEPTS 'NaN' / 'Infinity'.
    // checkReorder multiplies this field into a persisted purchase_orders.total,
    // so a poisoned row re-poisons every sweep and has no UI path to repair it.
    // Every sibling service carries this floor; see assertLineNumbers.
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "each" });
    const supplierId = await createSupplier(actor, { name: "S" });

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number("1e999"), -1]) {
      await expect(upsertSupplierItem(actor, { supplierId, itemId, lastUnitCost: bad }))
        .rejects.toThrow(InvalidPoInputError);
    }

    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(supplierItems).where(eq(supplierItems.supplierId, supplierId)));
    expect(rows).toHaveLength(0);
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

  // Linking an item to a supplier before its price is known is a legitimate
  // call. With every optional field undefined, drizzle's mapUpdateSet threw
  // "No values to set" while BUILDING the onConflictDoUpdate — so it fired even
  // on a first insert with no conflict, and the route turned it into a 500.
  it("links an item with no optional fields at all (itemId only)", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const supplierId = await createSupplier(actor, { name: "S" });
    const itemId = await seedItem(tenantId, { baseUom: "each" });

    await expect(upsertSupplierItem(actor, { supplierId, itemId })).resolves.toBeUndefined();

    const rows = await listSupplierItems(tenantId, supplierId);
    expect(rows).toHaveLength(1);
    expect(rows[0].itemId).toBe(itemId);
    expect(rows[0].lastUnitCost).toBeNull();

    // And it stays idempotent: a second bare link must not throw or duplicate.
    await expect(upsertSupplierItem(actor, { supplierId, itemId })).resolves.toBeUndefined();
    expect(await listSupplierItems(tenantId, supplierId)).toHaveLength(1);
  });

  it("a cost-only upsert preserves supplierSku and packUom (C7 reviewer pin)", async () => {
    const { tenantId, branchId } = await seedInventoryTenant();
    const actor = await seedActor(tenantId, branchId);
    const itemId = await seedItem(tenantId, { baseUom: "g" });
    const supplierId = await createSupplier(actor, { name: "S" });

    await upsertSupplierItem(actor, { supplierId, itemId, supplierSku: "SKU1", packUom: "kg", lastUnitCost: 10 });
    await upsertSupplierItem(actor, { supplierId, itemId, lastUnitCost: 12 });

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(supplierItems)
      .where(eq(supplierItems.supplierId, supplierId)));
    expect(Number(row?.lastUnitCost)).toBe(12);
    // The omitted keys survive — a partial upsert must not erase them.
    expect(row?.supplierSku).toBe("SKU1");
    expect(row?.packUom).toBe("kg");
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
