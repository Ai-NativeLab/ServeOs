import { pgTable, uuid, text, timestamp, boolean, integer, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";

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
  basePrice: numeric("base_price").notNull(),
  imageUrl: text("image_url"),
  brand: text("brand"),
  sku: text("sku"),
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
