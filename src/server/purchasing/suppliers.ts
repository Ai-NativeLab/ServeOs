import { eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { requireCapability } from "@/server/verticals/registry";
import type { VerticalId } from "@/server/verticals/types";
import type { UnitOfMeasure } from "@/server/catalog/uom";
import { assertInventoryUom } from "@/server/inventory/uom";
import { money } from "@/server/ordering/service";
import { suppliers, supplierItems } from "./schema";
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

export async function updateSupplier(actor: PurchasingActor, supplierId: string, input: UpdateSupplierInput): Promise<void> {
  requireCapability(actor.vertical, "inventory");
  return withTenant(actor.tenantId, async (tx) => {
    await tx.update(suppliers)
      .set({
        name: input.name,
        contactName: input.contactName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        paymentTerms: input.paymentTerms ?? null,
        notes: input.notes ?? null,
        isActive: input.isActive,
      })
      .where(eq(suppliers.id, supplierId));
    await recordAuditEvent(auditCtx(actor), {
      action: "supplier.updated",
      entityType: "supplier",
      entityId: supplierId,
      summary: `Supplier ${input.name ? `"${input.name}" ` : ""}updated`,
      metadata: input,
    }, tx);
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
        supplierSku: input.supplierSku ?? null,
        lastUnitCost: input.lastUnitCost !== undefined ? money(input.lastUnitCost) : undefined,
        packUom,
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
