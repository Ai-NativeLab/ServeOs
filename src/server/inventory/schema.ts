import { pgTable, uuid, text, timestamp, boolean, numeric, pgEnum, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { products, productVariants } from "@/server/catalog/schema";
// ONE platform-wide UoM enum (decision T1) — P4 shipped it and reserved it for
// this spec. Do NOT declare an inventory_uom enum. It is a superset carrying
// P4's sellable dimensional units (m/m2/bf); uom.ts rejects those as inventory
// units, since a pg enum cannot express the subset.
import { unitOfMeasureEnum } from "@/server/catalog/uom";

export const inventoryItemKindEnum = pgEnum("inventory_item_kind", ["ingredient", "finished_good", "raw_material"]);
export const storageLocationKindEnum = pgEnum("storage_location_kind", ["kitchen", "retail", "back_of_house", "transit"]);
export const stockLedgerTypeEnum = pgEnum("stock_ledger_type", [
  "receive", "sale_deduction", "adjustment", "count", "transfer", "waste", "refund_restock", "production",
]);
export const productInventoryLinkTypeEnum = pgEnum("product_inventory_link_type", ["recipe", "finished_good"]);
export const stockCountStatusEnum = pgEnum("stock_count_status", ["open", "committed", "cancelled"]);

/** A stockable thing: an ingredient, a finished good, a raw material. Distinct
 * from a sellable product/variant, which links to it via product_inventory_links.
 * All ledger quantities are normalized to baseUom; stock/purchase/recipe factors
 * convert the unit each context counts/buys/consumes it in. */
export const inventoryItems = pgTable("inventory_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  sku: text("sku"),
  kind: inventoryItemKindEnum("kind").notNull(),
  baseUom: unitOfMeasureEnum("base_uom").notNull(),
  stockUom: unitOfMeasureEnum("stock_uom").notNull(),
  stockToBase: numeric("stock_to_base").notNull().default("1"),
  purchaseUom: unitOfMeasureEnum("purchase_uom").notNull(),
  purchaseToBase: numeric("purchase_to_base").notNull().default("1"),
  recipeUom: unitOfMeasureEnum("recipe_uom").notNull(),
  recipeToBase: numeric("recipe_to_base").notNull().default("1"),
  isPerishable: boolean("is_perishable").notNull().default(false),
  defaultUnitCost: numeric("default_unit_cost"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("inventory_items_tenant").on(t.tenantId)]);

/** Stock lives at a location, at a branch — fixes today's single-global-count gap. */
export const storageLocations = pgTable("storage_locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: storageLocationKindEnum("kind").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("storage_locations_branch_kind").on(t.branchId, t.kind)]);

/** A receipt-dated, cost-bearing quantity of one item at one location.
 * qtyRemaining is a FIFO/expiry CACHE; the ledger is authoritative.
 * supplierId / poReceiptLineId are forward deps (Spec 9) — plain uuid, no FK yet. */
export const inventoryLots = pgTable("inventory_lots", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "restrict" }),
  lotCode: text("lot_code"),
  qtyReceived: numeric("qty_received").notNull(),
  qtyRemaining: numeric("qty_remaining").notNull(),
  unitCost: numeric("unit_cost").notNull().default("0"),
  supplierId: uuid("supplier_id"),          // → suppliers.id (Spec 9)
  poReceiptLineId: uuid("po_receipt_line_id"), // → po_receipt_lines.id (Spec 9)
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  expiryAt: timestamp("expiry_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("inventory_lots_fifo").on(t.itemId, t.locationId, t.receivedAt),
]);
// A partial index `WHERE qty_remaining > 0` is hand-appended (Step 4).

/** Append-only. On-hand(item, location) = Σ qty. Never UPDATE/DELETE (trigger).
 * qty is SIGNED in base UoM; uom is captured defensively at write time. */
export const stockLedger = pgTable("stock_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "restrict" }),
  lotId: uuid("lot_id").references(() => inventoryLots.id, { onDelete: "restrict" }),
  type: stockLedgerTypeEnum("type").notNull(),
  qty: numeric("qty").notNull(),
  uom: unitOfMeasureEnum("uom").notNull(),
  unitCost: numeric("unit_cost"),
  refType: text("ref_type"),
  refId: text("ref_id"),
  byUserId: uuid("by_user_id").references(() => users.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("stock_ledger_item_loc").on(t.tenantId, t.itemId, t.locationId),
  index("stock_ledger_ref").on(t.tenantId, t.refType, t.refId),
]);

export const stockCounts = pgTable("stock_counts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "restrict" }),
  status: stockCountStatusEnum("status").notNull().default("open"),
  startedByUserId: uuid("started_by_user_id").references(() => users.id),
  committedByUserId: uuid("committed_by_user_id").references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
});

export const stockCountLines = pgTable("stock_count_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  countId: uuid("count_id").notNull().references(() => stockCounts.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
  systemQty: numeric("system_qty").notNull(),
  countedQty: numeric("counted_qty").notNull(),
  varianceQty: numeric("variance_qty").notNull(),
  note: text("note"),
});

/** The BOM for one made-to-order sellable. yieldQty scales components:
 * a sold qty of n consumes each component × (n / yieldQty). */
export const recipes = pgTable("recipes", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  yieldQty: numeric("yield_qty").notNull().default("1"),
  yieldUom: unitOfMeasureEnum("yield_uom").notNull().default("each"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("recipes_tenant").on(t.tenantId)]);

export const recipeComponents = pgTable("recipe_components", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "restrict" }),
  qty: numeric("qty").notNull(),
  uom: unitOfMeasureEnum("uom").notNull(),
  wastePct: numeric("waste_pct").notNull().default("0"),
}, (t) => [index("recipe_components_recipe").on(t.recipeId)]);

/** Bridge from sellable → stockable. XOR: exactly one of (recipeId, itemId).
 * Unique per (productId, variantId) with NULL variant treated as one value. */
export const productInventoryLinks = pgTable("product_inventory_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  variantId: uuid("variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  linkType: productInventoryLinkTypeEnum("link_type").notNull(),
  recipeId: uuid("recipe_id").references(() => recipes.id, { onDelete: "restrict" }),
  itemId: uuid("item_id").references(() => inventoryItems.id, { onDelete: "restrict" }),
}, (t) => [index("product_inventory_links_product").on(t.productId)]);
// The XOR CHECK and the two partial unique indexes are hand-appended (Step 4).

export type InventoryItem = typeof inventoryItems.$inferSelect;
export type InventoryLot = typeof inventoryLots.$inferSelect;
export type StockLedgerRow = typeof stockLedger.$inferSelect;
export type StorageLocation = typeof storageLocations.$inferSelect;
export type Recipe = typeof recipes.$inferSelect;
export type RecipeComponent = typeof recipeComponents.$inferSelect;
export type ProductInventoryLink = typeof productInventoryLinks.$inferSelect;
export type StockCount = typeof stockCounts.$inferSelect;
export type StockCountLine = typeof stockCountLines.$inferSelect;
