import { pgTable, uuid, text, timestamp, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

export const customerStatusEnum = pgEnum("customer_status", ["active", "disabled"]);

/**
 * Storefront customers — PER TENANT by owner decision C1 (2026-08-03): a Roma
 * account is not a Nobio account, so the same email may exist at both. Staff
 * live in `users`; the two populations never share a table or a session lane.
 */
export const customers = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  passwordHash: text("password_hash").notNull(),
  defaultAddressText: text("default_address_text"),
  status: customerStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("customers_tenant_email").on(t.tenantId, t.email),
]);

/**
 * A separate session lane from staff (C4): own table, own cookie. Stores the
 * sha256 of the token, never the token — a database read cannot mint a login.
 */
export const customerSessions = pgTable("customer_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("customer_sessions_token").on(t.tokenHash),
  index("customer_sessions_customer").on(t.customerId),
]);

export type Customer = typeof customers.$inferSelect;
export type CustomerSession = typeof customerSessions.$inferSelect;
