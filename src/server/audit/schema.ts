import { pgTable, uuid, text, timestamp, jsonb, bigint, char, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";

export const auditActorTypeEnum = pgEnum("audit_actor_type", ["user", "system", "device", "customer"]);

/**
 * Append-only, tenant-scoped, hash-chained. One row per mutating action, auth
 * event, or sensitive read. Never updated, never deleted — the
 * audit_events_append_only trigger enforces it. `seq`/`prevHash`/`entryHash`
 * are set by recordAuditEvent under the per-tenant advisory lock; `createdAt`
 * is captured from the DB clock inside the tx and is part of the hash, so it
 * cannot be back-dated after the fact.
 */
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  actorType: auditActorTypeEnum("actor_type").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  summary: text("summary").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  fingerprint: jsonb("fingerprint").$type<Record<string, unknown>>().notNull().default({}),
  seq: bigint("seq", { mode: "number" }).notNull(),
  prevHash: char("prev_hash", { length: 64 }).notNull(),
  entryHash: char("entry_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("audit_events_tenant_seq").on(t.tenantId, t.seq),
  index("audit_events_tenant_created").on(t.tenantId, t.createdAt),
  index("audit_events_tenant_entity").on(t.tenantId, t.entityType, t.entityId),
  index("audit_events_tenant_action").on(t.tenantId, t.action),
]);

/** The current tip of a tenant's chain. Read-and-advanced under the advisory lock. */
export const auditChainHeads = pgTable("audit_chain_heads", {
  tenantId: uuid("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  seq: bigint("seq", { mode: "number" }).notNull(),
  headHash: char("head_hash", { length: 64 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditEvent = typeof auditEvents.$inferSelect;
export type AuditChainHead = typeof auditChainHeads.$inferSelect;
