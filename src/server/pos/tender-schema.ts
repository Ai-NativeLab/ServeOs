import { pgTable, uuid, text, timestamp, numeric, jsonb, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders, orderItems } from "@/server/ordering/schema";
import { posDevices } from "./schema";

export const posTenderMethodEnum = pgEnum("pos_tender_method", ["cash", "card", "other"]);
export const posAdjustmentTypeEnum = pgEnum("pos_adjustment_type", [
  "line_discount", "order_discount", "line_void", "order_void",
]);

/**
 * The money source of truth for a POS sale. One row per tender, so a split
 * payment is simply two rows. `shiftId` is unused in this spec — Spec 2
 * (Shifts & Cash Drawer) populates it, which is why it is nullable now.
 */
export const orderPayments = pgTable("order_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  method: posTenderMethodEnum("method").notNull(),
  amount: numeric("amount").notNull(),
  tipAmount: numeric("tip_amount").notNull().default("0"),
  tenderedAmount: numeric("tendered_amount"),
  changeAmount: numeric("change_amount"),
  reference: text("reference"),
  takenByUserId: uuid("taken_by_user_id").notNull().references(() => users.id),
  shiftId: uuid("shift_id"),
  clientPaymentId: text("client_payment_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("order_payments_order_client").on(t.orderId, t.clientPaymentId),
  index("order_payments_order").on(t.orderId),
]);

/** Append-only audit trail: every discount and void, who did it, who approved it. */
export const posAdjustmentEvents = pgTable("pos_adjustment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderItemId: uuid("order_item_id").references(() => orderItems.id, { onDelete: "cascade" }),
  type: posAdjustmentTypeEnum("type").notNull(),
  amount: numeric("amount").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonText: text("reason_text"),
  byUserId: uuid("by_user_id").notNull().references(() => users.id),
  authorizedByUserId: uuid("authorized_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_adjustment_events_order").on(t.orderId)]);

/** A parked sale. Server-side so till 2 can recall what till 1 parked. */
export const posHeldTickets = pgTable("pos_held_tickets", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  cashierUserId: uuid("cashier_user_id").notNull().references(() => users.id),
  label: text("label").notNull(),
  draftJson: jsonb("draft_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_held_tickets_branch").on(t.branchId)]);

export type OrderPayment = typeof orderPayments.$inferSelect;
export type PosAdjustmentEvent = typeof posAdjustmentEvents.$inferSelect;
export type PosHeldTicket = typeof posHeldTickets.$inferSelect;
