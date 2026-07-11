import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { checkQuota } from "@/server/entitlements/service";
import {
  categories,
  products,
  modifierGroups,
  modifierOptions,
  branchProductAvailability,
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

// ── helpers ──────────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}

// ── categories ───────────────────────────────────────────────────────────────

export type CreateCategoryInput = Pick<NewCategory, "nameEn" | "nameAr" | "descriptionEn" | "descriptionAr" | "imageUrl" | "sortOrder">;
export type UpdateCategoryInput = Partial<CreateCategoryInput & { isActive: boolean }>;

export async function listCategories(tenantId: string): Promise<Category[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(categories).orderBy(categories.sortOrder),
  );
}

export async function createCategory(tenantId: string, input: CreateCategoryInput): Promise<Category> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(categories).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateCategory(tenantId: string, categoryId: string, input: UpdateCategoryInput): Promise<Category> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(categories)
      .set(input)
      .where(and(eq(categories.id, categoryId), eq(categories.tenantId, tenantId)))
      .returning(),
  );
  if (!row) throw new Error("Category not found");
  return row;
}

export async function deleteCategory(tenantId: string, categoryId: string): Promise<void> {
  const [{ value }] = await withTenant(tenantId, (tx) =>
    tx.select({ value: count() }).from(products).where(eq(products.categoryId, categoryId)),
  );
  if (Number(value) > 0) throw new CategoryNotEmptyError();
  await withTenant(tenantId, (tx) =>
    tx.delete(categories).where(and(eq(categories.id, categoryId), eq(categories.tenantId, tenantId))),
  );
}

// ── products ─────────────────────────────────────────────────────────────────

export type CreateProductInput = Pick<NewProduct, "nameEn" | "nameAr" | "descriptionEn" | "descriptionAr" | "basePrice" | "imageUrl" | "sortOrder" | "categoryId" | "isFeatured">;
export type UpdateProductInput = Partial<CreateProductInput & { isPublished: boolean }>;

export async function listProducts(tenantId: string, categoryId?: string): Promise<Product[]> {
  return withTenant(tenantId, (tx) => {
    const q = tx.select().from(products);
    return categoryId
      ? q.where(and(eq(products.tenantId, tenantId), eq(products.categoryId, categoryId))).orderBy(products.sortOrder)
      : q.orderBy(products.sortOrder);
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

export async function createProduct(tenantId: string, input: CreateProductInput): Promise<Product> {
  const [{ value }] = await withTenant(tenantId, (tx) =>
    tx.select({ value: count() }).from(products),
  );
  await checkQuota(tenantId, "products", Number(value));
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(products).values({ ...input, tenantId }).returning(),
  );
  return row;
}

export async function updateProduct(tenantId: string, productId: string, input: UpdateProductInput): Promise<Product> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.update(products)
      .set(input)
      .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
      .returning(),
  );
  if (!row) throw new ProductNotFoundError();
  return row;
}

export async function deleteProduct(tenantId: string, productId: string): Promise<void> {
  const [row] = await withTenant(tenantId, (tx) =>
    tx.delete(products).where(and(eq(products.id, productId), eq(products.tenantId, tenantId))).returning({ id: products.id }),
  );
  if (!row) throw new ProductNotFoundError();
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

export async function upsertModifierGroup(tenantId: string, productId: string, input: ModifierGroupInput): Promise<ModifierGroup> {
  if (input.minSelections > input.maxSelections) throw new InvalidModifierRulesError();
  if (input.required && input.minSelections < 1) throw new InvalidModifierRulesError();

  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(modifierGroups)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, required: input.required, minSelections: input.minSelections, maxSelections: input.maxSelections, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(modifierGroups.id, input.id!), eq(modifierGroups.tenantId, tenantId), eq(modifierGroups.productId, productId)))
        .returning(),
    );
    if (!row) throw new Error("Modifier group not found");
    return row;
  }

  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(modifierGroups).values({ tenantId, productId, nameEn: input.nameEn, nameAr: input.nameAr, required: input.required, minSelections: input.minSelections, maxSelections: input.maxSelections, sortOrder: input.sortOrder ?? 0 }).returning(),
  );
  return row;
}

export async function deleteModifierGroup(tenantId: string, groupId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(modifierGroups).where(and(eq(modifierGroups.id, groupId), eq(modifierGroups.tenantId, tenantId))),
  );
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

export async function upsertModifierOption(tenantId: string, groupId: string, input: ModifierOptionInput): Promise<ModifierOption> {
  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(modifierOptions)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, priceDelta: input.priceDelta ?? "0", isDefault: input.isDefault ?? false, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(modifierOptions.id, input.id!), eq(modifierOptions.tenantId, tenantId)))
        .returning(),
    );
    if (!row) throw new Error("Modifier option not found");
    return row;
  }

  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(modifierOptions).values({ tenantId, modifierGroupId: groupId, nameEn: input.nameEn, nameAr: input.nameAr, priceDelta: input.priceDelta ?? "0", isDefault: input.isDefault ?? false, sortOrder: input.sortOrder ?? 0 }).returning(),
  );
  return row;
}

export async function deleteModifierOption(tenantId: string, optionId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(modifierOptions).where(and(eq(modifierOptions.id, optionId), eq(modifierOptions.tenantId, tenantId))),
  );
}

// ── branch availability ───────────────────────────────────────────────────────

export async function setBranchAvailability(
  tenantId: string,
  branchId: string,
  productId: string,
  available: boolean,
  priceOverride?: number,
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
          imageUrl: products.imageUrl,
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
        imageUrl: r.imageUrl,
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

    const prodsByCat = groupBy(
      prodRows.map((p) => ({
        id: p.id,
        nameEn: p.nameEn,
        nameAr: p.nameAr,
        descriptionEn: p.descriptionEn,
        descriptionAr: p.descriptionAr,
        effectivePrice: Number(p.basePrice),
        imageUrl: p.imageUrl,
        isFeatured: p.isFeatured,
        createdAt: p.createdAt.toISOString(),
        modifierGroups: groupsByProduct[p.id] ?? [],
        categoryId: p.categoryId,
      })),
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
