import { pgTable, uuid, text, timestamp, numeric, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { subscriptions } from "@/server/subscription/schema";
import { users } from "@/server/auth/schema";

export const invoiceStatus = pgEnum("invoice_status", ["open", "paid", "void"]);

export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  amount: numeric("amount").notNull(),
  currency: text("currency").notNull(),
  status: invoiceStatus("status").notNull().default("open"),
  method: text("method"), // bank | cash | manual
  markedBy: uuid("marked_by").references(() => users.id),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Invoice = typeof invoices.$inferSelect;
