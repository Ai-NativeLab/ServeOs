import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }), // null = super-admin
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    passwordHash: text("password_hash"),
    locale: text("locale").notNull().default("ar"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_per_tenant").on(t.tenantId, t.email),
    uniqueIndex("users_phone_per_tenant").on(t.tenantId, t.phone),
    uniqueIndex("users_email_platform_unique").on(t.email).where(sql`${t.tenantId} IS NULL`),
    uniqueIndex("users_phone_platform_unique").on(t.phone).where(sql`${t.tenantId} IS NULL`),
  ],
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // opaque random token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }), // null = platform role
    key: text("key").notNull(), // owner | manager | staff | super_admin
    name: text("name").notNull(),
  },
  // Every get-or-create-role path is select-then-insert, which races: two
  // concurrent callers both see nothing and both insert, leaving a user with
  // the same role twice over two different role rows. These constraints make
  // the database refuse it, so the race resolves to a conflict instead.
  //
  // Two indexes, not one: Postgres treats NULLs as distinct, so the composite
  // never constrains platform roles. Same shape as users_email_platform_unique.
  (t) => [
    uniqueIndex("roles_key_per_tenant").on(t.tenantId, t.key),
    uniqueIndex("roles_key_platform_unique").on(t.key).where(sql`${t.tenantId} IS NULL`),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("user_roles_pk").on(t.userId, t.roleId)],
);

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Role = typeof roles.$inferSelect;
