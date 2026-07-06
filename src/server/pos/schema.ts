import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders } from "@/server/ordering/schema";

export const posDevices = pgTable("pos_devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  label: text("label").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [uniqueIndex("pos_devices_token").on(t.token)]);

export const posPairingCodes = pgTable("pos_pairing_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  label: text("label").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("pos_pairing_codes_code").on(t.code)]);

// Idempotency: one row per (device, clientOrderId) -> the order it produced.
export const posOrderReceipts = pgTable("pos_order_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  clientOrderId: text("client_order_id").notNull(),
  orderId: uuid("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderNumber: text("order_number").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("pos_order_receipts_device_client").on(t.deviceId, t.clientOrderId)]);

export type PosDevice = typeof posDevices.$inferSelect;
export type PosPairingCode = typeof posPairingCodes.$inferSelect;
export type PosOrderReceipt = typeof posOrderReceipts.$inferSelect;
