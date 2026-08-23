import { pgTable, uuid, text, timestamp, boolean, integer, numeric, uniqueIndex, bigint } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { unitOfMeasureEnum, type UnitOfMeasure } from "./uom";

export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  descriptionEn: text("description_en"),
  descriptionAr: text("description_ar"),
  imageUrl: text("image_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  categoryId: uuid("category_id").notNull().references(() => categories.id, { onDelete: "restrict" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  descriptionEn: text("description_en"),
  descriptionAr: text("description_ar"),
  // Null = fixed price per each (every existing vertical, unchanged). Set =
  // basePrice is REINTERPRETED as price-per-unit-of-measure (P4, decision T2)
  // — one number, one meaning per row, no second price column.
  unitOfMeasure: unitOfMeasureEnum("unit_of_measure"),
  basePrice: numeric("base_price").notNull(),
  imageUrl: text("image_url"),
  brand: text("brand"),
  sku: text("sku"),
  /** P3: prescription-only medicine. Capability-gated to pharmacy. */
  requiresPrescription: boolean("requires_prescription").notNull().default(false),
  trackStock: boolean("track_stock").notNull().default(false),
  stockQuantity: integer("stock_quantity"),
  isFeatured: boolean("is_featured").notNull().default(false),
  isPublished: boolean("is_published").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productVariants = pgTable("product_variants", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  sku: text("sku"),
  // Absolute price: a variant is a purchasable unit, not a delta on basePrice.
  price: numeric("price").notNull(),
  // null = not tracked (always purchasable).
  stockQuantity: integer("stock_quantity"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;

export const modifierGroups = pgTable("modifier_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  required: boolean("required").notNull().default(false),
  minSelections: integer("min_selections").notNull().default(0),
  maxSelections: integer("max_selections").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const modifierOptions = pgTable("modifier_options", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  modifierGroupId: uuid("modifier_group_id").notNull().references(() => modifierGroups.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  priceDelta: numeric("price_delta").notNull().default("0"),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const branchProductAvailability = pgTable(
  "branch_product_availability",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    isAvailable: boolean("is_available").notNull().default(true),
    priceOverride: numeric("price_override"),
  },
  (t) => [uniqueIndex("bpa_branch_product_unique").on(t.branchId, t.productId)],
);

/**
 * Per-tenant monotonic counter — NOT max(updated_at). A MAX over catalog
 * tables can't see a delete (max is unchanged) or a branch price-override /
 * VAT / service-charge edit (no catalog row moves at all), so a drift check
 * built on it would report "same catalog" while pricing genuinely moved.
 * Bumped by bumpCatalogVersion (./version.ts) from catalog mutations, branch
 * price-override writes, and tenant tax-settings changes — always on the
 * caller's transaction, one row per tenant. Tenant data, so RLS-backed like
 * every other table in this file (same shape as audit_chain_heads).
 */
export const catalogVersions = pgTable("catalog_versions", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  version: bigint("version", { mode: "number" }).notNull(),
});

export type CatalogVersion = typeof catalogVersions.$inferSelect;

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type ModifierGroup = typeof modifierGroups.$inferSelect;
export type ModifierOption = typeof modifierOptions.$inferSelect;
export type BranchProductAvailability = typeof branchProductAvailability.$inferSelect;

export type ModifierGroupWithOptions = ModifierGroup & { options: ModifierOption[] };
export type ProductWithModifiers = Product & { modifierGroups: ModifierGroupWithOptions[] };

export interface PublishedMenu {
  categories: Array<{
    id: string;
    nameEn: string;
    nameAr: string;
    imageUrl: string | null;
    products: Array<{
      id: string;
      nameEn: string;
      nameAr: string;
      descriptionEn: string | null;
      descriptionAr: string | null;
      effectivePrice: number;
      /** P4: set only for dimensional products — effectivePrice is then the
       *  price PER UNIT OF MEASURE, not a fixed each-price. */
      unitOfMeasure: UnitOfMeasure | null;
      /** P3: prescription-only — the storefront badges it and gates checkout. */
      requiresPrescription: boolean;
      imageUrl: string | null;
      brand: string | null;
      inStock: boolean;
      variants: Array<{ id: string; nameEn: string; nameAr: string; price: number; inStock: boolean }>;
      isFeatured: boolean;
      createdAt: string;
      modifierGroups: ModifierGroupWithOptions[];
    }>;
  }>;
}
