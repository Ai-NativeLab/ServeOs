import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { getTenantById } from "@/server/tenancy";
import { requireCapability, type VerticalId } from "@/server/verticals";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { productVariants, products, type ProductVariant } from "./schema";
import { ProductNotFoundError } from "./errors";

function auditCtx(tenantId: string, audit?: AuditActorInput) {
  return { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
}
function auditMeta(audit: AuditActorInput | undefined, extra: Record<string, unknown> = {}) {
  return { roleKey: audit?.roleKey ?? null, ...extra };
}

export type VariantInput = {
  id?: string;
  nameEn: string;
  nameAr: string;
  sku?: string | null;
  price: string;
  stockQuantity?: number | null;
  isActive?: boolean;
  sortOrder?: number;
};

async function requireTenantCapability(tenantId: string, cap: "variants" | "stockTracking"): Promise<void> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new ProductNotFoundError();
  requireCapability(tenant.vertical as VerticalId, cap);
}

export async function listVariants(tenantId: string, productId: string): Promise<ProductVariant[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(productVariants).where(eq(productVariants.productId, productId)).orderBy(productVariants.sortOrder),
  );
}

export async function upsertVariant(tenantId: string, productId: string, input: VariantInput, audit?: AuditActorInput): Promise<ProductVariant> {
  await requireTenantCapability(tenantId, "variants");
  return withTenant(tenantId, async (tx) => {
    let row: ProductVariant | undefined;
    if (input.id) {
      [row] = await tx.update(productVariants)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(productVariants.id, input.id!), eq(productVariants.productId, productId)))
        .returning();
      if (!row) throw new ProductNotFoundError();
    } else {
      [row] = await tx.insert(productVariants)
        .values({ tenantId, productId, nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
        .returning();
    }
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.variant.upserted", entityType: "product_variant", entityId: row.id,
      summary: `Variant "${row.nameEn}" saved`, metadata: auditMeta(audit, { productId, price: row.price }), actorType: audit?.actorType,
    }, tx);
    return row;
  });
}

export async function deleteVariant(tenantId: string, variantId: string, audit?: AuditActorInput): Promise<void> {
  await requireTenantCapability(tenantId, "variants");
  await withTenant(tenantId, async (tx) => {
    await tx.delete(productVariants).where(eq(productVariants.id, variantId));
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.variant.deleted", entityType: "product_variant", entityId: variantId,
      summary: `Variant deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
  });
}

export async function setVariantStock(tenantId: string, variantId: string, qty: number | null, audit?: AuditActorInput): Promise<void> {
  await requireTenantCapability(tenantId, "stockTracking");
  await withTenant(tenantId, async (tx) => {
    const [before] = await tx.select({ stockQuantity: productVariants.stockQuantity }).from(productVariants).where(eq(productVariants.id, variantId)).limit(1);
    await tx.update(productVariants).set({ stockQuantity: qty }).where(eq(productVariants.id, variantId));
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.stock.set", entityType: "product_variant", entityId: variantId,
      summary: `Variant stock ${before?.stockQuantity ?? "∅"} → ${qty ?? "∅"}`,
      metadata: auditMeta(audit, { before: before?.stockQuantity ?? null, after: qty }), actorType: audit?.actorType,
    }, tx);
  });
}

export async function setProductStock(tenantId: string, productId: string, qty: number | null, audit?: AuditActorInput): Promise<void> {
  await requireTenantCapability(tenantId, "stockTracking");
  await withTenant(tenantId, async (tx) => {
    const [before] = await tx.select({ stockQuantity: products.stockQuantity }).from(products).where(eq(products.id, productId)).limit(1);
    await tx.update(products).set({ stockQuantity: qty, trackStock: qty !== null }).where(eq(products.id, productId));
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.stock.set", entityType: "product", entityId: productId,
      summary: `Product stock ${before?.stockQuantity ?? "∅"} → ${qty ?? "∅"}`,
      metadata: auditMeta(audit, { before: before?.stockQuantity ?? null, after: qty }), actorType: audit?.actorType,
    }, tx);
  });
}
