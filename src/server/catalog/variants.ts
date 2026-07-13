import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { getTenantById } from "@/server/tenancy";
import { requireCapability, type VerticalId } from "@/server/verticals";
import { productVariants, products, type ProductVariant } from "./schema";
import { ProductNotFoundError } from "./errors";

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

export async function upsertVariant(tenantId: string, productId: string, input: VariantInput): Promise<ProductVariant> {
  await requireTenantCapability(tenantId, "variants");
  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(productVariants)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(productVariants.id, input.id!), eq(productVariants.productId, productId)))
        .returning(),
    );
    if (!row) throw new ProductNotFoundError();
    return row;
  }
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(productVariants)
      .values({ tenantId, productId, nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
      .returning(),
  );
  return row;
}

export async function deleteVariant(tenantId: string, variantId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(productVariants).where(eq(productVariants.id, variantId)),
  );
}

export async function setVariantStock(tenantId: string, variantId: string, qty: number | null): Promise<void> {
  await requireTenantCapability(tenantId, "stockTracking");
  await withTenant(tenantId, (tx) =>
    tx.update(productVariants).set({ stockQuantity: qty }).where(eq(productVariants.id, variantId)),
  );
}

export async function setProductStock(tenantId: string, productId: string, qty: number | null): Promise<void> {
  await requireTenantCapability(tenantId, "stockTracking");
  await withTenant(tenantId, (tx) =>
    tx.update(products).set({ stockQuantity: qty, trackStock: qty !== null }).where(eq(products.id, productId)),
  );
}
