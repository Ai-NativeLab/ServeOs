import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { checkQuota } from "@/server/entitlements/service";
import { getTenantById } from "@/server/tenancy";
import { requireCapability, type VerticalId } from "@/server/verticals";
import {
  categories,
  products,
  modifierGroups,
  modifierOptions,
  branchProductAvailability,
  productVariants,
  type Category,
  type NewCategory,
  type Product,
  type NewProduct,
  type ModifierGroup,
  type ModifierOption,
  type ModifierGroupWithOptions,
  type ProductWithModifiers,
  type PublishedMenu,
} from "./schema";
import {
  CategoryNotEmptyError,
  ProductNotFoundError,
  InvalidModifierRulesError,
} from "./errors";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { bumpCatalogVersion } from "./version";
import { computeEffectivePrice } from "./pricing";

// ── helpers ──────────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}

/** The AuditContext for a catalog mutation. actorUserId null (backfill/seed) is
 *  fine — recordAuditEvent then records `system`. */
function auditCtx(tenantId: string, audit?: AuditActorInput) {
  return { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() };
}
/** Every catalog event carries the actor's roleKey (null for system) in metadata. */
function auditMeta(audit: AuditActorInput | undefined, extra: Record<string, unknown> = {}) {
  return { roleKey: audit?.roleKey ?? null, ...extra };
}

// ── categories ───────────────────────────────────────────────────────────────

export type CreateCategoryInput = Pick<NewCategory, "nameEn" | "nameAr" | "descriptionEn" | "descriptionAr" | "imageUrl" | "sortOrder">;
export type UpdateCategoryInput = Partial<CreateCategoryInput & { isActive: boolean }>;

export async function listCategories(tenantId: string): Promise<Category[]> {
  // Explicitly scoped, not RLS-only — see the note on listBranches.
  return withTenant(tenantId, (tx) =>
    tx.select().from(categories)
      .where(eq(categories.tenantId, tenantId))
      .orderBy(categories.sortOrder),
  );
}

export async function createCategory(tenantId: string, input: CreateCategoryInput, audit?: AuditActorInput): Promise<Category> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(categories).values({ ...input, tenantId }).returning();
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.category.created", entityType: "category", entityId: row.id,
      summary: `Category "${row.nameEn}" created`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
    return row;
  });
}

export async function updateCategory(tenantId: string, categoryId: string, input: UpdateCategoryInput, audit?: AuditActorInput): Promise<Category> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(categories)
      .set(input)
      .where(and(eq(categories.id, categoryId), eq(categories.tenantId, tenantId)))
      .returning();
    if (!row) throw new Error("Category not found");
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.category.updated", entityType: "category", entityId: row.id,
      summary: `Category "${row.nameEn}" updated`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
    return row;
  });
}

export async function deleteCategory(tenantId: string, categoryId: string, audit?: AuditActorInput): Promise<void> {
  const [{ value }] = await withTenant(tenantId, (tx) =>
    tx.select({ value: count() }).from(products).where(eq(products.categoryId, categoryId)),
  );
  if (Number(value) > 0) throw new CategoryNotEmptyError();
  await withTenant(tenantId, async (tx) => {
    await tx.delete(categories).where(and(eq(categories.id, categoryId), eq(categories.tenantId, tenantId)));
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.category.deleted", entityType: "category", entityId: categoryId,
      summary: `Category deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
  });
}

// ── products ─────────────────────────────────────────────────────────────────

export type CreateProductInput = Pick<NewProduct, "nameEn" | "nameAr" | "descriptionEn" | "descriptionAr" | "basePrice" | "salePrice" | "discountPercent" | "discountStartsAt" | "discountEndsAt" | "discountActive" | "imageUrl" | "sortOrder" | "categoryId" | "isFeatured" | "brand" | "sku" | "trackStock" | "stockQuantity">;
export type UpdateProductInput = Partial<CreateProductInput & { isPublished: boolean }>;

export async function listProducts(tenantId: string, categoryId?: string): Promise<Product[]> {
  return withTenant(tenantId, (tx) => {
    const q = tx.select().from(products);
    return categoryId
      ? q.where(and(eq(products.tenantId, tenantId), eq(products.categoryId, categoryId))).orderBy(products.sortOrder)
      : q.where(eq(products.tenantId, tenantId)).orderBy(products.sortOrder);
  });
}

export async function getProduct(tenantId: string, productId: string): Promise<ProductWithModifiers> {
  const [prod] = await withTenant(tenantId, (tx) =>
    tx.select().from(products).where(eq(products.id, productId)).limit(1),
  );
  if (!prod) throw new ProductNotFoundError();

  const groups = await withTenant(tenantId, (tx) =>
    tx.select().from(modifierGroups).where(eq(modifierGroups.productId, productId)).orderBy(modifierGroups.sortOrder),
  );

  const groupIds = groups.map((g) => g.id);
  const opts = groupIds.length > 0
    ? await withTenant(tenantId, (tx) =>
        tx.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds)).orderBy(modifierOptions.sortOrder),
      )
    : [];

  const optsByGroup = groupBy(opts, (o) => o.modifierGroupId);
  return {
    ...prod,
    modifierGroups: groups.map((g) => ({ ...g, options: optsByGroup[g.id] ?? [] })),
  };
}

export async function createProduct(tenantId: string, input: CreateProductInput, audit?: AuditActorInput): Promise<Product> {
  // Explicitly this tenant's products — see the note in createBranch on why a
  // quota count must not lean on RLS alone.
  const [{ value }] = await withTenant(tenantId, (tx) =>
    tx.select({ value: count() }).from(products).where(eq(products.tenantId, tenantId)),
  );
  await checkQuota(tenantId, "products", Number(value));
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.insert(products).values({ ...input, tenantId }).returning();
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.product.created", entityType: "product", entityId: row.id,
      summary: `Product "${row.nameEn}" created`,
      metadata: auditMeta(audit, { basePrice: row.basePrice }), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
    return row;
  });
}

export async function updateProduct(tenantId: string, productId: string, input: UpdateProductInput, audit?: AuditActorInput): Promise<Product> {
  return withTenant(tenantId, async (tx) => {
    const [before] = await tx.select().from(products).where(eq(products.id, productId)).limit(1);
    const [row] = await tx.update(products)
      .set(input)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .returning();
    if (!row) throw new ProductNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.product.updated", entityType: "product", entityId: row.id,
      summary: `Product "${row.nameEn}" updated`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    // A price move is its own event so the log answers "who changed the price?"
    // directly, without diffing generic update rows.
    if (before && before.basePrice !== row.basePrice) {
      await recordAuditEvent(auditCtx(tenantId, audit), {
        action: "catalog.product.price_changed", entityType: "product", entityId: row.id,
        summary: `Price ${before.basePrice} → ${row.basePrice}`,
        metadata: auditMeta(audit, { before: before.basePrice, after: row.basePrice }), actorType: audit?.actorType,
      }, tx);
    }
    await bumpCatalogVersion(tenantId, tx);
    return row;
  });
}

export async function deleteProduct(tenantId: string, productId: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx.delete(products).where(and(eq(products.id, productId), eq(products.tenantId, tenantId))).returning({ id: products.id });
    if (!row) throw new ProductNotFoundError();
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.product.deleted", entityType: "product", entityId: productId,
      summary: `Product deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
  });
}

// ── modifier groups ───────────────────────────────────────────────────────────

export type ModifierGroupInput = {
  id?: string;
  nameEn: string;
  nameAr: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  sortOrder?: number;
};

export async function upsertModifierGroup(tenantId: string, productId: string, input: ModifierGroupInput, audit?: AuditActorInput): Promise<ModifierGroup> {
  const tenant = await getTenantById(tenantId);
  if (tenant) requireCapability(tenant.vertical as VerticalId, "modifiers");

  if (input.minSelections > input.maxSelections) throw new InvalidModifierRulesError();
  if (input.required && input.minSelections < 1) throw new InvalidModifierRulesError();

  return withTenant(tenantId, async (tx) => {
    let row: ModifierGroup | undefined;
    if (input.id) {
      [row] = await tx.update(modifierGroups)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, required: input.required, minSelections: input.minSelections, maxSelections: input.maxSelections, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(modifierGroups.id, input.id!), eq(modifierGroups.tenantId, tenantId), eq(modifierGroups.productId, productId)))
        .returning();
      if (!row) throw new Error("Modifier group not found");
    } else {
      [row] = await tx.insert(modifierGroups).values({ tenantId, productId, nameEn: input.nameEn, nameAr: input.nameAr, required: input.required, minSelections: input.minSelections, maxSelections: input.maxSelections, sortOrder: input.sortOrder ?? 0 }).returning();
    }
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.modifier_group.upserted", entityType: "modifier_group", entityId: row.id,
      summary: `Modifier group "${row.nameEn}" saved`, metadata: auditMeta(audit, { productId }), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
    return row;
  });
}

export async function deleteModifierGroup(tenantId: string, groupId: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.delete(modifierGroups).where(and(eq(modifierGroups.id, groupId), eq(modifierGroups.tenantId, tenantId)));
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.modifier_group.deleted", entityType: "modifier_group", entityId: groupId,
      summary: `Modifier group deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
  });
}

// ── modifier options ──────────────────────────────────────────────────────────

export type ModifierOptionInput = {
  id?: string;
  nameEn: string;
  nameAr: string;
  priceDelta?: string;
  isDefault?: boolean;
  sortOrder?: number;
};

export async function upsertModifierOption(tenantId: string, groupId: string, input: ModifierOptionInput, audit?: AuditActorInput): Promise<ModifierOption> {
  return withTenant(tenantId, async (tx) => {
    let row: ModifierOption | undefined;
    if (input.id) {
      [row] = await tx.update(modifierOptions)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, priceDelta: input.priceDelta ?? "0", isDefault: input.isDefault ?? false, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(modifierOptions.id, input.id!), eq(modifierOptions.tenantId, tenantId)))
        .returning();
      if (!row) throw new Error("Modifier option not found");
    } else {
      [row] = await tx.insert(modifierOptions).values({ tenantId, modifierGroupId: groupId, nameEn: input.nameEn, nameAr: input.nameAr, priceDelta: input.priceDelta ?? "0", isDefault: input.isDefault ?? false, sortOrder: input.sortOrder ?? 0 }).returning();
    }
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.modifier_option.upserted", entityType: "modifier_option", entityId: row.id,
      summary: `Modifier option "${row.nameEn}" saved`, metadata: auditMeta(audit, { modifierGroupId: groupId }), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
    return row;
  });
}

export async function deleteModifierOption(tenantId: string, optionId: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.delete(modifierOptions).where(and(eq(modifierOptions.id, optionId), eq(modifierOptions.tenantId, tenantId)));
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.modifier_option.deleted", entityType: "modifier_option", entityId: optionId,
      summary: `Modifier option deleted`, metadata: auditMeta(audit), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
  });
}

// ── branch availability ───────────────────────────────────────────────────────

export async function setBranchAvailability(
  tenantId: string,
  branchId: string,
  productId: string,
  available: boolean,
  priceOverride?: number,
  audit?: AuditActorInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    if (available && priceOverride === undefined) {
      await tx.delete(branchProductAvailability).where(
        and(
          eq(branchProductAvailability.branchId, branchId),
          eq(branchProductAvailability.productId, productId),
        ),
      );
    } else {
      await tx.insert(branchProductAvailability)
        .values({ tenantId, branchId, productId, isAvailable: available, priceOverride: priceOverride !== undefined ? String(priceOverride) : null })
        .onConflictDoUpdate({
          target: [branchProductAvailability.branchId, branchProductAvailability.productId],
          set: { isAvailable: available, priceOverride: priceOverride !== undefined ? String(priceOverride) : null },
        });
    }
    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: "catalog.branch_availability.changed", entityType: "product", entityId: productId,
      summary: `Availability at branch ${available ? "enabled" : "disabled"}`,
      metadata: auditMeta(audit, { branchId, available, priceOverride: priceOverride ?? null }), actorType: audit?.actorType,
    }, tx);
    await bumpCatalogVersion(tenantId, tx);
  });
}

// ── published menu ────────────────────────────────────────────────────────────

export async function getPublishedMenu(tenantId: string, branchId?: string): Promise<PublishedMenu> {
  return withTenant(tenantId, async (tx) => {
    const cats = await tx.select().from(categories).where(eq(categories.isActive, true)).orderBy(categories.sortOrder);

    let prodRows: Product[];
    if (branchId) {
      const rows = await tx
        .select({
          id: products.id,
          tenantId: products.tenantId,
          categoryId: products.categoryId,
          nameEn: products.nameEn,
          nameAr: products.nameAr,
          descriptionEn: products.descriptionEn,
          descriptionAr: products.descriptionAr,
          basePrice: products.basePrice,
          salePrice: products.salePrice,
          discountPercent: products.discountPercent,
          discountStartsAt: products.discountStartsAt,
          discountEndsAt: products.discountEndsAt,
          discountActive: products.discountActive,
          unitOfMeasure: products.unitOfMeasure,
          requiresPrescription: products.requiresPrescription,
          imageUrl: products.imageUrl,
          brand: products.brand,
          sku: products.sku,
          trackStock: products.trackStock,
          stockQuantity: products.stockQuantity,
          isFeatured: products.isFeatured,
          isPublished: products.isPublished,
          sortOrder: products.sortOrder,
          createdAt: products.createdAt,
          bpaAvailable: branchProductAvailability.isAvailable,
          bpaPriceOverride: branchProductAvailability.priceOverride,
        })
        .from(products)
        .leftJoin(
          branchProductAvailability,
          and(
            eq(branchProductAvailability.productId, products.id),
            eq(branchProductAvailability.branchId, branchId),
          ),
        )
        .where(
          and(
            eq(products.isPublished, true),
            or(isNull(branchProductAvailability.id), eq(branchProductAvailability.isAvailable, true)),
          ),
        )
        .orderBy(products.sortOrder);

      prodRows = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        categoryId: r.categoryId,
        nameEn: r.nameEn,
        nameAr: r.nameAr,
        descriptionEn: r.descriptionEn,
        descriptionAr: r.descriptionAr,
        basePrice: r.bpaPriceOverride ?? r.basePrice,
        salePrice: r.salePrice,
        discountPercent: r.discountPercent,
        discountStartsAt: r.discountStartsAt,
        discountEndsAt: r.discountEndsAt,
        discountActive: r.discountActive,
        unitOfMeasure: r.unitOfMeasure,
        requiresPrescription: r.requiresPrescription,
        imageUrl: r.imageUrl,
        brand: r.brand,
        sku: r.sku,
        trackStock: r.trackStock,
        stockQuantity: r.stockQuantity,
        isFeatured: r.isFeatured,
        isPublished: r.isPublished,
        sortOrder: r.sortOrder,
        createdAt: r.createdAt,
      }));
    } else {
      prodRows = await tx.select().from(products).where(eq(products.isPublished, true)).orderBy(products.sortOrder);
    }

    const productIds = prodRows.map((p) => p.id);
    if (productIds.length === 0) {
      return {
        categories: cats.map((c) => ({ id: c.id, nameEn: c.nameEn, nameAr: c.nameAr, imageUrl: c.imageUrl, products: [] })),
      };
    }

    const groups = await tx.select().from(modifierGroups).where(inArray(modifierGroups.productId, productIds)).orderBy(modifierGroups.sortOrder);
    const groupIds = groups.map((g) => g.id);
    const opts = groupIds.length > 0
      ? await tx.select().from(modifierOptions).where(inArray(modifierOptions.modifierGroupId, groupIds)).orderBy(modifierOptions.sortOrder)
      : [];

    const optsByGroup = groupBy(opts, (o) => o.modifierGroupId);
    const groupsWithOpts: ModifierGroupWithOptions[] = groups.map((g) => ({ ...g, options: optsByGroup[g.id] ?? [] }));
    const groupsByProduct = groupBy(groupsWithOpts, (g) => g.productId);

    const variantRows = productIds.length > 0
      ? await tx.select().from(productVariants)
          .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)))
          .orderBy(productVariants.sortOrder)
      : [];
    const variantsByProduct = groupBy(variantRows, (v) => v.productId);

    const prodsByCat = groupBy(
      prodRows.map((p) => {
        const pricing = computeEffectivePrice({
          basePrice: p.basePrice,
          salePrice: p.salePrice,
          discountPercent: p.discountPercent,
          discountStartsAt: p.discountStartsAt,
          discountEndsAt: p.discountEndsAt,
          discountActive: p.discountActive,
        });

        return {
          id: p.id,
          nameEn: p.nameEn,
          nameAr: p.nameAr,
          descriptionEn: p.descriptionEn,
          descriptionAr: p.descriptionAr,
          effectivePrice: pricing.effectivePrice,
          originalPrice: pricing.originalPrice,
          discountPercent: pricing.discountPercent,
          hasDiscount: pricing.hasDiscount,
          unitOfMeasure: p.unitOfMeasure,
          requiresPrescription: p.requiresPrescription,
          imageUrl: p.imageUrl,
          brand: p.brand,
          variants: (variantsByProduct[p.id] ?? []).map((v) => ({
            id: v.id, nameEn: v.nameEn, nameAr: v.nameAr,
            price: Number(v.price),
            inStock: v.stockQuantity === null || v.stockQuantity > 0,
          })),
          inStock: (variantsByProduct[p.id] ?? []).length > 0
            ? (variantsByProduct[p.id] ?? []).some((v) => v.stockQuantity === null || v.stockQuantity > 0)
            : p.trackStock
              ? (p.stockQuantity ?? 0) > 0
              : true,
          isFeatured: p.isFeatured,
          createdAt: p.createdAt.toISOString(),
          modifierGroups: groupsByProduct[p.id] ?? [],
          categoryId: p.categoryId,
        };
      }),
      (p) => p.categoryId,
    );

    return {
      categories: cats
        .map((c) => ({
          id: c.id,
          nameEn: c.nameEn,
          nameAr: c.nameAr,
          imageUrl: c.imageUrl,
          products: prodsByCat[c.id] ?? [],
        }))
        .filter((c) => c.products.length > 0),
    };
  });
}
