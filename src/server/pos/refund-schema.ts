import { pgTable, uuid, text, timestamp, integer, numeric, boolean, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders, orderItems } from "@/server/ordering/schema";

export const refundKindEnum = pgEnum("refund_kind", ["full", "partial"]);
export const refundMethodEnum = pgEnum("refund_method", ["cash", "card", "store_credit", "other"]);

/**
 * The header of one return against one completed order. An order may accrue many
 * partial refunds over time. Never mutates the order — it references it. `shiftId`
 * is a bare uuid (no FK) mirroring order_payments.shiftId: Spec 2 (Shifts) owns
 * pos_shifts and is not on-branch yet, so this is nullable and inert until then.
 */
export const refunds = pgTable("refunds", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  kind: refundKindEnum("kind").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonText: text("reason_text"),
  totalAmount: numeric("total_amount").notNull(),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  authorizedByUserId: uuid("authorized_by_user_id").references(() => users.id),
  shiftId: uuid("shift_id"),
  clientRefundId: text("client_refund_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("refunds_order_client").on(t.orderId, t.clientRefundId),
  index("refunds_order").on(t.orderId),
  index("refunds_tenant_branch_created").on(t.tenantId, t.branchId, t.createdAt),
]);

/** Per-item breakdown of a partial (or itemised full) refund; carries the per-line restock decision. */
export const refundLines = pgTable("refund_lines", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  refundId: uuid("refund_id").notNull().references(() => refunds.id, { onDelete: "cascade" }),
  orderItemId: uuid("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull(),
  amount: numeric("amount").notNull(),
  restock: boolean("restock").notNull().default(false),
}, (t) => [index("refund_lines_refund").on(t.refundId)]);

/** The tenders of a refund — money OUT. Mirror of order_payments, opposite direction. Stored positive. */
export const refundPayments = pgTable("refund_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  refundId: uuid("refund_id").notNull().references(() => refunds.id, { onDelete: "cascade" }),
  method: refundMethodEnum("method").notNull(),
  amount: numeric("amount").notNull(),
  reference: text("reference"),
  takenByUserId: uuid("taken_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("refund_payments_refund").on(t.refundId),
  index("refund_payments_tenant_created").on(t.tenantId, t.createdAt),
]);

export type Refund = typeof refunds.$inferSelect;
export type RefundLine = typeof refundLines.$inferSelect;
export type RefundPayment = typeof refundPayments.$inferSelect;
