import { pgTable, uuid, numeric, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { inventoryItems, storageLocations } from "@/server/inventory/schema";
import { suppliers } from "./schema";

/**
 * The reorder point, per item per location (Part D). Names are pinned by the
 * shipped `getLowStock` query (`src/server/analytics/service.ts:481`), which
 * has been waiting on this exact table: item_id, location_id, reorder_point,
 * is_active, on-hand from `inventory_lots.qty_remaining`.
 */
export const reorderRules = pgTable("reorder_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  itemId: uuid("item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => storageLocations.id, { onDelete: "cascade" }),
  reorderPoint: numeric("reorder_point").notNull(), // base UoM, qty(n)
  reorderQty: numeric("reorder_qty").notNull(), // base UoM, qty(n)
  preferredSupplierId: uuid("preferred_supplier_id").references(() => suppliers.id),
  lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }), // debounce clock
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("reorder_rules_item_location").on(t.itemId, t.locationId)]);

export type ReorderRule = typeof reorderRules.$inferSelect;
