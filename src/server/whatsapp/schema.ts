import { pgTable, uuid, text, timestamp, boolean, integer, pgEnum, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { orders } from "@/server/ordering/schema";

export const whatsappAccountStatusEnum = pgEnum("whatsapp_account_status", ["active", "disconnected", "suspended"]);

/**
 * CONTROL-PLANE — intentionally NO RLS, like pos_devices. An inbound webhook
 * carries only a phone_number_id; the tenant must be resolved from this table
 * before withTenant can open. Writes still happen inside withTenant so the
 * audit insert has app.tenant_id set (Spec 4).
 *
 * tokenRef is a SECRET-MANAGER REFERENCE, never a token and never ciphertext.
 * This table has no RLS, so one unscoped query would otherwise expose every
 * tenant's Meta credentials at once.
 */
export const whatsappAccounts = pgTable("whatsapp_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  wabaId: text("waba_id").notNull(),
  phoneNumberId: text("phone_number_id").notNull(),
  displayPhoneNumber: text("display_phone_number").notNull(),
  tokenRef: text("token_ref").notNull(),
  status: whatsappAccountStatusEnum("status").notNull().default("active"),
  coexistence: boolean("coexistence").notNull().default(true),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
}, (t) => [
  // PARTIAL unique: a churned number must be re-linkable by its next owner.
  // Verify the WHERE predicate survives generation (plan Task 1 Step 5).
  uniqueIndex("whatsapp_accounts_phone_active").on(t.phoneNumberId).where(sql`status = 'active'`),
]);

export type WhatsappAccount = typeof whatsappAccounts.$inferSelect;
export type WhatsappAccountStatus = (typeof whatsappAccountStatusEnum.enumValues)[number];

export const whatsappDirectionEnum = pgEnum("whatsapp_direction", ["inbound", "outbound"]);

/** Inbound + outbound log. The unique providerMessageId is the replay guard. */
export const whatsappMessages = pgTable("whatsapp_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  waId: text("wa_id").notNull(),
  direction: whatsappDirectionEnum("direction").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  deliveryStatus: text("delivery_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("whatsapp_messages_provider_id").on(t.providerMessageId),
  index("whatsapp_messages_tenant_wa").on(t.tenantId, t.waId),
]);

export type WhatsappMessage = typeof whatsappMessages.$inferSelect;

export const whatsappStateEnum = pgEnum("whatsapp_conversation_state", [
  "idle", "branch", "categories", "products", "variant", "cart", "fulfillment", "contact", "confirm", "placed",
]);

/** A cart line holds SELECTION IDS ONLY — never a price. Prices are resolved
 *  fresh at every render and again at confirm, so a stale chat cannot quote a
 *  number placeOrder would not charge. */
export type CartLine = { productId: string; variantId?: string; quantity: number };

export const whatsappConversations = pgTable("whatsapp_conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  waId: text("wa_id").notNull(),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  state: whatsappStateEnum("state").notNull().default("idle"),
  /** Bumped on every transition. Interactive ids embed it so a tap on a
   *  superseded message can be rejected instead of acted on. */
  stateVersion: integer("state_version").notNull().default(0),
  cart: jsonb("cart").$type<CartLine[]>().notNull().default([]),
  pendingProductId: uuid("pending_product_id"),
  customerName: text("customer_name"),
  profileName: text("profile_name"),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("whatsapp_conversations_tenant_wa").on(t.tenantId, t.waId)]);

/** Idempotency for the place-order effect — the pos_order_receipts pattern. */
export const whatsappOrderReceipts = pgTable("whatsapp_order_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => whatsappConversations.id, { onDelete: "cascade" }),
  confirmMessageId: text("confirm_message_id").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("whatsapp_order_receipts_conv_msg").on(t.conversationId, t.confirmMessageId)]);

export const cartHandoffTokens = pgTable("cart_handoff_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  waId: text("wa_id").notNull(),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  cart: jsonb("cart").$type<CartLine[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("cart_handoff_tokens_token").on(t.token)]);

export type WhatsappConversation = typeof whatsappConversations.$inferSelect;
export type ConversationState = (typeof whatsappStateEnum.enumValues)[number];
export type CartHandoffToken = typeof cartHandoffTokens.$inferSelect;
