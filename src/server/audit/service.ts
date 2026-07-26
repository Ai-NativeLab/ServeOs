import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { auditEvents, auditChainHeads } from "./schema";
import { entryHash, ZERO_HASH, type AuditActorType } from "./canonical";

export type AuditFingerprint = {
  deviceId: string | null;
  deviceTokenHash: string | null;
  appVersion: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type AuditContext = {
  tenantId: string;
  branchId?: string | null;
  actorUserId?: string | null;
  fingerprint: AuditFingerprint;
};

/** The optional `audit?` param every mutating service accepts (Tasks 6-9). */
export type AuditActorInput = {
  actorUserId?: string | null;
  actorType?: AuditActorType;
  fingerprint: AuditFingerprint;
  roleKey?: string | null;
};

export type AuditEventInput = {
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadata?: Record<string, unknown>;
  actorType?: AuditActorType;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Appends one row to the tenant's chain, ON THE CALLER'S TRANSACTION. Must be
 * called inside a withTenant(tenantId, tx => …) block: the advisory lock and
 * the head read/advance rely on app.tenant_id being set (RLS) and on the outer
 * commit for durability. Never opens its own transaction — the audit row is
 * atomic with the mutation it records. Safe to call more than once per tx (each
 * call sees the prior insert and advances the head again).
 */
export async function recordAuditEvent(ctx: AuditContext, event: AuditEventInput, tx: Tx): Promise<void> {
  // 1. Serialize the read-then-advance window per tenant — same lock, same key
  //    as placeOrder's order-number step. Re-acquiring a lock the transaction
  //    already holds is a no-op, so this is safe even when placeOrder is the caller.
  // Intentionally the SAME per-tenant key placeOrder uses — one lock order avoids deadlock; correctness rests on the unique (tenant, seq) index + RLS, not this lock.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId})::bigint)`);

  // 2. Read the head (genesis if absent).
  const [head] = await tx.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, ctx.tenantId)).limit(1);
  const prevSeq = head?.seq ?? 0;
  const prevHash = head?.headHash ?? ZERO_HASH;
  const seq = prevSeq + 1;

  // 3. Capture the DB clock inside the tx so the stored createdAt IS the hashed
  //    createdAt (millisecond precision both ways).
  // now() is transaction_timestamp() — identical for every append in one tx; rows are ordered by seq, never by createdAt.
  const nowRes = await tx.execute<{ now: Date }>(sql`SELECT now() AS now`);
  const createdAt = new Date(nowRes.rows[0].now);

  const actorUserId = ctx.actorUserId ?? null;
  const metadata = event.metadata ?? {};

  // 4. Hash over exactly the nine spec fields (fingerprint is NOT hashed).
  const hash = entryHash({
    prevHash, seq, tenantId: ctx.tenantId, actorUserId,
    action: event.action, entityType: event.entityType, entityId: event.entityId,
    metadata, createdAt: createdAt.toISOString(),
  });

  // 5. Insert the row.
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    branchId: ctx.branchId ?? null,
    actorUserId,
    actorType: event.actorType ?? (actorUserId ? "user" : "system"),
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    summary: event.summary,
    metadata,
    fingerprint: ctx.fingerprint,
    seq, prevHash, entryHash: hash, createdAt,
  });

  // 6. Advance the head (create on genesis, update thereafter).
  await tx.insert(auditChainHeads)
    .values({ tenantId: ctx.tenantId, seq, headHash: hash, updatedAt: createdAt })
    .onConflictDoUpdate({
      target: auditChainHeads.tenantId,
      set: { seq, headHash: hash, updatedAt: createdAt },
    });
}
