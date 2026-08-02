import { pgTable, uuid, text, timestamp, boolean, pgEnum, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";

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
