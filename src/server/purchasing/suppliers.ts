import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import type { VerticalId } from "@/server/verticals/types";
import type { UnitOfMeasure } from "@/server/catalog/uom";
import { assertInventoryUom } from "@/server/inventory/uom";
import { money } from "@/server/ordering/service";
import { inventoryItems } from "@/server/inventory/schema";
import { suppliers, supplierItems } from "./schema";
import type { Supplier } from "./schema";
import { InvalidPoInputError } from "./errors";
export type PurchasingActor = {
  tenantId: string;
  branchId: string;
  actorUserId: string;
  vertical: VerticalId;
};

function auditCtx(actor: PurchasingActor) {
  return {
    tenantId: actor.tenantId,
    branchId: actor.branchId,
    actorUserId: actor.actorUserId,
    fingerprint: emptyFingerprint(),
  };
}

export type CreateSupplierInput = {
  name: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  paymentTerms?: string | null;
  notes?: string | null;
};

export type UpdateSupplierInput = Partial<CreateSupplierInput & { isActive: boolean }>;

export async function createSupplier(actor: PurchasingActor, input: CreateSupplierInput): Promise<string> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    const [row] = await tx.insert(suppliers).values({
      tenantId: actor.tenantId,
      name: input.name,
      contactName: input.contactName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      paymentTerms: input.paymentTerms ?? null,
      notes: input.notes ?? null,
    }).returning({ id: suppliers.id });
    await recordAuditEvent(auditCtx(actor), {
      action: "supplier.created",
      entityType: "supplier",
      entityId: row.id,
      summary: `Supplier "${input.name}" created`,
      metadata: { name: input.name },
    }, tx);
    return row.id;
  });
}

export async function updateSupplier(
  actor: PurchasingActor, supplierId: string, input: UpdateSupplierInput,
): Promise<Supplier | null> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    // Partial PATCH must not clobber unspecified nullable fields: only copy the
    // keys the caller actually set (`!== undefined`), so `contactName ?? null`
    // never erases a field merely because the payload omitted it.
    const patch: { [K in keyof UpdateSupplierInput]?: unknown } = {};
    for (const key of ["name", "contactName", "email", "phone", "paymentTerms", "notes", "isActive"] as const) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    if (Object.keys(patch).length === 0) return null;

    const [row] = await tx.update(suppliers)
      .set(patch as never)
      .where(eq(suppliers.id, supplierId))
      .returning();
    if (!row) return null;
    await recordAuditEvent(auditCtx(actor), {
      action: "supplier.updated",
      entityType: "supplier",
      entityId: row.id,
      summary: `Supplier ${row.name ? `"${row.name}" ` : ""}updated`,
      metadata: input,
    }, tx);
    return row;
  });
}

export type UpsertSupplierItemInput = {
  supplierId: string;
  itemId: string;
  supplierSku?: string | null;
  lastUnitCost?: number;
  packUom?: UnitOfMeasure;
};

export async function upsertSupplierItem(actor: PurchasingActor, input: UpsertSupplierItemInput): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  const packUom = input.packUom ? assertInventoryUom(input.packUom) : null;
  return withTenant(actor.tenantId, async (tx) => {
    // RLS covers the write, not the FK: a body-supplied supplierId/itemId could
    // reference another tenant's row. Resolving both under our RLS is the check.
    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId));
    if (!supplier) throw new InvalidPoInputError(`supplierId ${input.supplierId} is not a supplier of this tenant`);
    const [item] = await tx.select().from(inventoryItems).where(eq(inventoryItems.id, input.itemId));
    if (!item) throw new InvalidPoInputError(`itemId ${input.itemId} is not an item of this tenant`);

    await tx.insert(supplierItems).values({
      tenantId: actor.tenantId,
      supplierId: input.supplierId,
      itemId: input.itemId,
      supplierSku: input.supplierSku ?? null,
      lastUnitCost: input.lastUnitCost !== undefined ? money(input.lastUnitCost) : null,
      packUom,
    }).onConflictDoUpdate({
      target: [supplierItems.supplierId, supplierItems.itemId],
      set: {
        // Only touch keys the caller provided so a partial upsert doesn't erase
        // the stored supplierSku/packUom/lastUnitCost (drizzle skips `undefined`).
        supplierSku: input.supplierSku !== undefined ? input.supplierSku : undefined,
        lastUnitCost: input.lastUnitCost !== undefined ? money(input.lastUnitCost) : undefined,
        packUom: input.packUom !== undefined ? assertInventoryUom(input.packUom) : undefined,
      },
    });
    await recordAuditEvent(auditCtx(actor), {
      action: "supplier.item.upserted",
      entityType: "supplier",
      entityId: input.supplierId,
      summary: `Supplier item ${input.itemId} upserted`,
      metadata: { itemId: input.itemId, lastUnitCost: input.lastUnitCost },
    }, tx);
  });
}

export async function listSuppliers(tenantId: string) {
  return withTenant(tenantId, async (tx) =>
    tx.select().from(suppliers).orderBy(suppliers.name));
}

export async function listSupplierItems(tenantId: string, supplierId: string) {
  return withTenant(tenantId, async (tx) =>
    tx.select().from(supplierItems).where(eq(supplierItems.supplierId, supplierId)));
}
