import { and, desc, eq, gte, lte } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents, auditChainHeads, type AuditEvent } from "./schema";
import { verifyChain, type ChainStatus } from "./verifier";

export type AuditEventFilters = {
  action?: string; entityType?: string; entityId?: string; actorUserId?: string; actorType?: string;
  from?: Date; to?: Date; limit?: number;
};

/** Newest-first (desc seq), RLS-scoped, capped at 200. No HTTP path ever inserts. */
export async function listAuditEvents(tenantId: string, filters: AuditEventFilters): Promise<AuditEvent[]> {
  return withTenant(tenantId, (tx) => {
    const conds = [];
    if (filters.action) conds.push(eq(auditEvents.action, filters.action));
    if (filters.entityType) conds.push(eq(auditEvents.entityType, filters.entityType));
    if (filters.entityId) conds.push(eq(auditEvents.entityId, filters.entityId));
    if (filters.actorUserId) conds.push(eq(auditEvents.actorUserId, filters.actorUserId));
    if (filters.actorType) conds.push(eq(auditEvents.actorType, filters.actorType as never));
    if (filters.from) conds.push(gte(auditEvents.createdAt, filters.from));
    if (filters.to) conds.push(lte(auditEvents.createdAt, filters.to));
    const base = tx.select().from(auditEvents);
    const q = conds.length > 0 ? base.where(and(...conds)) : base;
    return q.orderBy(desc(auditEvents.seq)).limit(Math.min(filters.limit ?? 100, 200));
  });
}

export async function getChainStatus(tenantId: string): Promise<{ head: { seq: number; headHash: string } | null; verification: ChainStatus }> {
  const head = await withTenant(tenantId, (tx) =>
    tx.select().from(auditChainHeads).where(eq(auditChainHeads.tenantId, tenantId)).limit(1));
  return {
    head: head[0] ? { seq: head[0].seq, headHash: head[0].headHash } : null,
    verification: await verifyChain(tenantId),
  };
}
