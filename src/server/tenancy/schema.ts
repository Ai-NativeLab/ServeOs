import { pgTable, uuid, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";

export const tenantStatus = pgEnum("tenant_status", [
  "onboarding",
  "trial",
  "active",
  "suspended",
  "rejected",
]);

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  status: tenantStatus("status").notNull().default("onboarding"),
  country: text("country").notNull(), // "EG" | "SA"
  currency: text("currency").notNull().default("EGP"),
  defaultLocale: text("default_locale").notNull().default("ar"),
  timezone: text("timezone").notNull().default("Africa/Cairo"),
  customDomain: text("custom_domain").unique(),
  logoUrl: text("logo_url"),
  coverImageUrl: text("cover_image_url"),
  primaryColor: text("primary_color").notNull().default("#0F172A"),
  theme: text("theme").notNull().default("default"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;

export const tenantSettings = pgTable("tenant_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  data: jsonb("data").notNull().default({}),
});
export type TenantSettings = typeof tenantSettings.$inferSelect;
