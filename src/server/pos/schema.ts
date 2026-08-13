import { pgTable, uuid, text, timestamp, uniqueIndex, index, jsonb, boolean } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders } from "@/server/ordering/schema";
import type { Permission } from "@/server/rbac/permissions";

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

/** Cashier sessions. Control-plane like pos_devices: no RLS. Keyed by the
 *  SHA-256 of the bearer token — a read-only DB leak must not hand out live
 *  sessions. A row outliving its expiry is inert — resolveCashier checks expiresAt. */
export const posCashierSessions = pgTable("pos_cashier_sessions", {
  tokenHash: text("token_hash").primaryKey(),   // sha256 hex of the raw token
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  permissions: jsonb("permissions").$type<Permission[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_cashier_sessions_expires").on(t.expiresAt)]);

/** Manager grants. Same control-plane shape as pos_cashier_sessions: no RLS,
 *  keyed by the SHA-256 of the bearer token. Single-use is enforced by
 *  consumeGrant's DELETE ... RETURNING, not by a column here. */
export const posGrants = pgTable("pos_grants", {
  tokenHash: text("token_hash").primaryKey(),   // sha256 hex, same helper as sessions
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  authorizedByUserId: uuid("authorized_by_user_id").notNull().references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Mirror of pos_order_receipts, for non-sale sync events (shift/cash/ticket
 *  lifecycle — Task 5): each replayable service inserts its row as the LAST
 *  statement of its OWN tenant transaction, which is why this table carries
 *  no RLS — same reasoning as pos_order_receipts. resultJson is the response
 *  a retry of (deviceId, eventId) replays verbatim instead of re-running the
 *  effect. No `id` column: the (deviceId, eventId) pair IS the row identity. */
export const posSyncEventReceipts = pgTable("pos_sync_event_receipts", {
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull(),
  type: text("type").notNull(),
  resultJson: jsonb("result_json").$type<Record<string, unknown>>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  clockSkewFlagged: boolean("clock_skew_flagged").notNull().default(false),
}, (t) => [uniqueIndex("pos_sync_event_receipts_key").on(t.deviceId, t.eventId)]);

export type PosDevice = typeof posDevices.$inferSelect;
export type PosPairingCode = typeof posPairingCodes.$inferSelect;
export type PosOrderReceipt = typeof posOrderReceipts.$inferSelect;
export type PosCashierSession = typeof posCashierSessions.$inferSelect;
export type PosGrant = typeof posGrants.$inferSelect;
export type PosSyncEventReceipt = typeof posSyncEventReceipts.$inferSelect;
