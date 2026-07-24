import { pgTable, uuid, text, timestamp, numeric, integer, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";

export type PlanLimits = {
  branches: number;
  staff: number;
  products: number;
  whatsapp_numbers: number;
  orders_per_month: number;
  messages_per_month: number;
};
export type PlanFeatures = {
  whatsapp: boolean;
  custom_domain: boolean;
  custom_theme: boolean;
  reservations: boolean;
  advanced_analytics: boolean;
  online_ordering: boolean;
};

export const plans = pgTable("plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  priceMonthly: numeric("price_monthly").notNull().default("0"),
  currency: text("currency").notNull().default("EGP"),
  isActive: text("is_active").notNull().default("true"),
  limits: jsonb("limits").$type<PlanLimits>().notNull(),
  features: jsonb("features").$type<PlanFeatures>().notNull(),
  lemonSqueezyVariantId: text("lemon_squeezy_variant_id"),
});

export const subscriptionStatus = pgEnum("subscription_status", [
  "trialing",
  "active",
  "past_due",
  "suspended",
  "canceled",
]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").notNull().references(() => plans.id),
  status: subscriptionStatus("status").notNull().default("trialing"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  provider: text("provider").notNull().default("manual"),
  providerSubscriptionId: text("provider_subscription_id"),
  providerCustomerId: text("provider_customer_id"),
});

export const usageCounters = pgTable("usage_counters", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(), // "orders" | "messages"
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
});

export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
