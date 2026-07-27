import { pgTable, uuid, text, timestamp, numeric, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { subscriptions, plans } from "@/server/subscription/schema";
import { users } from "@/server/auth/schema";

export const invoiceStatus = pgEnum("invoice_status", ["open", "pending_verification", "paid", "void"]);

export const invoices = pgTable("invoices", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  // Target plan for a manual plan-invoice (set by createPlanInvoice); null for
  // invoices created via the generic BillingProvider interface.
  planId: uuid("plan_id").references(() => plans.id),
  amount: numeric("amount").notNull(),
  currency: text("currency").notNull(),
  status: invoiceStatus("status").notNull().default("open"),
  method: text("method"), // bank | cash | manual
  paymentReference: text("payment_reference"),
  paymentProofUrl: text("payment_proof_url"),
  providerRef: text("provider_ref"),
  markedBy: uuid("marked_by").references(() => users.id),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // At most one outstanding (open or pending_verification) invoice per tenant
  // — enforced in the DB so a concurrent double-submit of subscribeToPlanAction
  // can't create two open invoices (the pre-check in the action is racy on its
  // own). See src/server/payments/offline/methods.schema.ts for the same
  // pattern applied to offline methods.
  uniqueIndex("invoices_one_outstanding_per_tenant").on(t.tenantId).where(sql`status in ('open','pending_verification')`),
]);

export type Invoice = typeof invoices.$inferSelect;
