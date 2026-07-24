import { pgTable, uuid, text, timestamp, integer, numeric, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";

export const orderStatusEnum = pgEnum("order_status", [
  "pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed", "rejected", "cancelled",
]);
export const fulfillmentTypeEnum = pgEnum("fulfillment_type", ["pickup", "delivery"]);
export const orderChannelEnum = pgEnum("order_channel", ["web"]);
export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "pending_verification", "paid"]);
export const paymentMethodEnum = pgEnum("payment_method", ["cash", "instapay", "vodafone_cash", "mobile_wallet"]);

export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type FulfillmentType = (typeof fulfillmentTypeEnum.enumValues)[number];

export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "restrict" }),
  orderNumber: integer("order_number").notNull(),
  status: orderStatusEnum("status").notNull().default("pending"),
  fulfillmentType: fulfillmentTypeEnum("fulfillment_type").notNull(),
  channel: orderChannelEnum("channel").notNull().default("web"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  paymentMethod: paymentMethodEnum("payment_method").notNull().default("cash"),
  paymentReference: text("payment_reference"),
  paymentProofUrl: text("payment_proof_url"),
  paymentProviderRef: text("payment_provider_ref"),
  customerName: text("customer_name").notNull(),
  customerPhone: text("customer_phone").notNull(),
  notes: text("notes"),
  deliveryAreaId: uuid("delivery_area_id"),
  deliveryAreaNameSnapshot: text("delivery_area_name_snapshot"),
  deliveryAddressText: text("delivery_address_text"),
  subtotal: numeric("subtotal").notNull(),
  vatRateSnapshot: numeric("vat_rate_snapshot").notNull(),
  vatAmount: numeric("vat_amount").notNull(),
  serviceChargeAmount: numeric("service_charge_amount"),
  deliveryFee: numeric("delivery_fee").notNull().default("0"),
  total: numeric("total").notNull(),
  statusToken: text("status_token").notNull().unique(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SelectedModifier = {
  groupNameEn: string; groupNameAr: string; optionNameEn: string; optionNameAr: string; priceDelta: string;
};

export const orderItems = pgTable("order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull(),
  variantId: uuid("variant_id"),
  variantNameEn: text("variant_name_en"),
  variantNameAr: text("variant_name_ar"),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  unitBasePrice: numeric("unit_base_price").notNull(),
  quantity: integer("quantity").notNull(),
  lineTotal: numeric("line_total").notNull(),
  selectedModifiers: jsonb("selected_modifiers").$type<SelectedModifier[]>().notNull().default([]),
});

export const orderStatusEvents = pgTable("order_status_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  fromStatus: orderStatusEnum("from_status"),
  toStatus: orderStatusEnum("to_status").notNull(),
  changedByUserId: uuid("changed_by_user_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderItem = typeof orderItems.$inferSelect;
export type OrderStatusEvent = typeof orderStatusEvents.$inferSelect;
export type OrderWithItems = Order & { items: OrderItem[] };
export type OrderDetail = Order & { items: OrderItem[]; events: OrderStatusEvent[] };
