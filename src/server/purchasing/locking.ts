import { sql } from "drizzle-orm";
import type { Tx } from "@/db/with-tenant";

/**
 * Takes the per-tenant advisory lock that every tenant-scoped write in this
 * domain serializes on.
 *
 * It MUST be the first statement in the transaction. `recordAuditEvent` grabs
 * this same key at the *end* of whatever calls it, so any writer that touches a
 * row before acquiring it inverts the lock order against a writer that acquires
 * it first — and the two deadlock (40P01).
 *
 * That is not hypothetical. `checkReorder` acquires this key first and then
 * updates an open draft PO; `sendPurchaseOrder` / `updateDraftPo` /
 * `cancelPurchaseOrder` take `SELECT ... FOR UPDATE` on that same draft and
 * only reach the key via their closing audit event. Racing them deadlocked on
 * 12 of 12 rounds before this helper existed:
 *
 *   T1  FOR UPDATE on draft PO X  ──► blocks wanting the advisory key
 *   T2  advisory key              ──► blocks wanting the row lock on X
 *
 * Advisory locks are re-entrant within a transaction, so `recordAuditEvent`
 * re-acquiring it later is a no-op. The cost of taking it up front is that a
 * tenant's purchasing writes serialize; that is the intended trade — the same
 * one `createDraftPo` already made for PO numbering.
 */
export async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);
}
