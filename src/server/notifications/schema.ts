import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";

/** Shared by every spec that raises notifications (8, 9, 2, 3, 7, 4) — they
 *  import these values rather than redefining them. system_alert covers the
 *  layer's own failures (send budget exhausted, tamper break). */
export const notificationTypeEnum = pgEnum("notification_type", [
  "low_stock", "reorder_suggested", "po_sent", "po_received",
  "shift_variance", "reconciliation_exception", "refund_issued", "system_alert",
]);
export const notificationSeverityEnum = pgEnum("notification_severity", ["info", "warning", "critical"]);
export const outboxStatusEnum = pgEnum("outbox_status", ["queued", "sending", "sent", "failed"]);
export const emailEventTypeEnum = pgEnum("email_event_type", ["delivered", "bounced", "complained", "opened"]);

/** The in-app feed. One row per (target, event); role rows are stored once,
 *  not fanned out per user. Never emailed directly — email goes via the outbox. */
export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  targetRole: text("target_role"),
  type: notificationTypeEnum("type").notNull(),
  severity: notificationSeverityEnum("severity").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("notifications_tenant_user_read").on(t.tenantId, t.userId, t.readAt),
  index("notifications_tenant_role_created").on(t.tenantId, t.targetRole, t.createdAt),
  // A notification aimed at nobody is a bug, not a broadcast.
  check("notifications_target_present", sql`user_id IS NOT NULL OR target_role IS NOT NULL`),
]);

/** The email send queue — store-and-forward. notify() inserts; the worker
 *  drains. nextAttemptAt is the backoff clock (deviation from the spec's
 *  column list: attempts alone cannot express "eligible again at T" across
 *  worker restarts). */
export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  toEmail: text("to_email").notNull(),
  replyTo: text("reply_to"),
  subject: text("subject").notNull(),
  template: text("template").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: outboxStatusEnum("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  providerMessageId: text("provider_message_id"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [
  // The worker's claim query: only sendable rows, oldest eligibility first.
  index("notification_outbox_claim").on(t.status, t.nextAttemptAt),
]);

/** Provider delivery feedback, deduped. CONTROL-PLANE — keyed by provider ids
 *  (a webhook carries no tenant), joined back through providerMessageId. */
export const emailEvents = pgTable("email_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").notNull(),
  providerMessageId: text("provider_message_id").notNull(),
  providerEventId: text("provider_event_id").notNull(),
  eventType: emailEventTypeEnum("event_type").notNull(),
  raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The dedupe key: a retried webhook delivery is a no-op second insert.
  uniqueIndex("email_events_provider_event").on(t.provider, t.providerEventId),
]);

export type Notification = typeof notifications.$inferSelect;
export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type EmailEvent = typeof emailEvents.$inferSelect;
export type NotificationType = (typeof notificationTypeEnum.enumValues)[number];
export type NotificationSeverity = (typeof notificationSeverityEnum.enumValues)[number];
export type EmailEventType = (typeof emailEventTypeEnum.enumValues)[number];
