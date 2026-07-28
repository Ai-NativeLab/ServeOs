import { pgTable, uuid, text, boolean, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

/** Per-tenant configured pay-to channels (Surface A). RLS like other tenant data. */
export const tenantOfflineMethods = pgTable("tenant_offline_methods", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  type: text("type").notNull(),          // OfflineMethodType
  label: text("label").notNull(),        // e.g. "Vodafone Cash"
  payToDetail: text("pay_to_detail"),    // number / InstaPay address / IBAN; null for cash
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most one configured method per (tenant, type) — enforced in the DB so
  // concurrent double-submits can't create duplicates and upsertOfflineMethod
  // can rely on onConflictDoUpdate instead of a racy check-then-act.
  uniqueIndex("tenant_offline_methods_tenant_type_unique").on(t.tenantId, t.type),
]);
export type TenantOfflineMethod = typeof tenantOfflineMethods.$inferSelect;
export type NewTenantOfflineMethod = typeof tenantOfflineMethods.$inferInsert;
