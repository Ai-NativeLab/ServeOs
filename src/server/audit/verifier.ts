import { asc } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "./schema";
import { entryHash, ZERO_HASH } from "./canonical";

export type ChainStatus =
  | { ok: true; seq: number; headHash: string }
  | { ok: false; brokenSeq: number };

/**
 * Walks a tenant's chain in seq order, recomputing each entryHash from the
 * stored fields and checking prevHash == the previous row's entryHash. Returns
 * the first seq that diverges. Read-only, RLS-scoped — a break is a finding,
 * never auto-repaired (Spec 5 turns it into an alert).
 *
 * Scope/limitations:
 * - Validates INTERNAL linkage only. It does NOT detect tail truncation
 *   (deletion of the most-recent rows) — there is no surviving later row whose
 *   prevHash would break. Catching that needs reconciliation against
 *   audit_chain_heads under snapshot isolation (to avoid false positives on
 *   concurrent appends); deferred to the Task 11 / Spec 5 status surface.
 * - Loads the whole chain into memory (O(chain length)); fine at this feature's
 *   per-tenant, periodic-job scale — very large tenants would later need
 *   cursor/checkpoint-based verification.
 */
export async function verifyChain(tenantId: string): Promise<ChainStatus> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).orderBy(asc(auditEvents.seq)));

  let prevHash = ZERO_HASH;
  for (const row of rows) {
    if (row.prevHash !== prevHash) return { ok: false, brokenSeq: row.seq };
    const recomputed = entryHash({
      prevHash, seq: row.seq, tenantId, actorUserId: row.actorUserId,
      action: row.action, entityType: row.entityType, entityId: row.entityId,
      metadata: row.metadata, createdAt: row.createdAt.toISOString(),
    });
    if (recomputed !== row.entryHash) return { ok: false, brokenSeq: row.seq };
    prevHash = row.entryHash;
  }
  return { ok: true, seq: rows.length === 0 ? 0 : rows[rows.length - 1].seq, headHash: prevHash };
}
