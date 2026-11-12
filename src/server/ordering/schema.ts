import { pgTable, uuid, text, timestamp, integer, numeric, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";

export const orderStatusEnum = pgEnum("order_status", [
  "pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed", "rejected", "cancelled",
]);
export const fulfillmentTypeEnum = pgEnum("fulfillment_type", ["pickup", "delivery"]);
export const orderChannelEnum = pgEnum("order_channel", ["web", "pos", "whatsapp"]);
export const paymentStatusEnum = pgEnum("payment_status", ["unpaid", "pending_verification", "partially_paid", "paid", "refunded", "partially_refunded"]);
/** P3: pharmacist review is a SEPARATE axis from order_status (decision R2) —
 *  it gates pending -> confirmed without adding a status every vertical sees. */
export const rxReviewStatusEnum = pgEnum("rx_review_status", ["not_required", "pending", "approved", "rejected"]);
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
  /**
   * FISCAL DOCUMENT DELIVERY ONLY — NEVER MARKETING. This sentence is the
   * contract, not a preference, and it is written here because there is nowhere
   * else it could live: ServeOS has no marketing-consent flag on any table, so
   * NOTHING IN THE SCHEMA CAN REFUSE A MARKETING SEND EXCEPT THIS JSDOC. A
   * column of customer addresses with no stated purpose is a column that gets
   * repurposed, and the repurposing does not look like a decision when it
   * happens — it looks like `select customer_email from orders` in a campaign
   * script two quarters from now, written by someone who never saw this comment
   * because they never opened this file.
   *
   * So, in as many words: this address may be used to send the customer THEIR
   * OWN tax document for THIS order (round 2, Task 7 —
   * `@/server/fiscal/customer-email`) and for nothing else. Not a newsletter,
   * not an abandoned-cart nudge, not a loyalty invitation, not "we're open on
   * Eid". Adding any such use means adding a consent flag and a withdrawal
   * path FIRST; until one exists, this contract IS the refusal.
   *
   * WHY IT IS CAPTURED AT ALL, and why it is optional. An online order's ETA
   * receipt is written by the reconciliation sweep 5-20 minutes after payment
   * (addendum §6), long after the customer has closed the status page — so the
   * storefront's fiscal block is what a REVISIT shows, and the email is the
   * customer's only reliable copy of the QR. Optional because a tax receipt is
   * the seller's obligation to FILE, not the buyer's obligation to receive: no
   * address simply means no send (`resolveFiscalEmailRecipient`), never a
   * blocked checkout and never a blocked acceptance.
   *
   * NULLABLE FOREVER, and not backfillable. Every order placed before this
   * column existed has null here, and so does every POS sale — the till
   * captures no email at any point in its flow (recorded as scope in Task 7,
   * not as an oversight). A signed-in customer's `customers.email` is the
   * second rung of the resolution ladder and covers some of that gap; a guest
   * who leaves this blank is simply not emailed.
   */
  customerEmail: text("customer_email"),
  notes: text("notes"),
  cashierUserId: uuid("cashier_user_id"),
  rxReviewStatus: rxReviewStatusEnum("rx_review_status").notNull().default("not_required"),
  /** P2: set when a signed-in customer checks out; guest orders stay null forever. */
  customerId: uuid("customer_id"),
  discountAmount: numeric("discount_amount").notNull().default("0"),
  discountReason: text("discount_reason"),
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
  discountAmount: numeric("discount_amount").notNull().default("0"),
  selectedModifiers: jsonb("selected_modifiers").$type<SelectedModifier[]>().notNull().default([]),
  /** P4: the cut-list dimensions this line was priced from. Null for every
   *  non-dimensional line (every vertical except timber). */
  dimensions: jsonb("dimensions").$type<{ lengthMm?: number; widthMm?: number; thicknessMm?: number }>(),
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
