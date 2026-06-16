import { pgTable, uuid, text, timestamp, boolean, integer, numeric, jsonb } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

/** One entry per weekday. day: 0=Sunday … 6=Saturday. Times are "HH:MM" 24h,
 * interpreted in the branch's local wall-clock. When close < open the window
 * crosses midnight. An empty openingHours array means "no schedule configured"
 * → always within hours (the acceptingOrders toggle still applies). */
export type DayHours = { day: number; open: string; close: string; closed: boolean };
export type OpeningHours = DayHours[];

export const branches = pgTable("branches", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  phone: text("phone"),
  isActive: boolean("is_active").notNull().default(true),
  acceptingOrders: boolean("accepting_orders").notNull().default(true),
  openingHours: jsonb("opening_hours").$type<OpeningHours>().notNull().default([]),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deliveryAreas = pgTable("delivery_areas", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  deliveryFee: numeric("delivery_fee").notNull().default("0"),
  minOrderAmount: numeric("min_order_amount").notNull().default("0"),
  etaMinutes: integer("eta_minutes"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type DeliveryArea = typeof deliveryAreas.$inferSelect;
export type NewDeliveryArea = typeof deliveryAreas.$inferInsert;
