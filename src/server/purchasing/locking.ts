import { sql } from "drizzle-orm";
import type { Tx } from "@/db/with-tenant";

/**
 * THE RULE, in one line: never hold `hashtext(tenantId)` while waiting for a
 * row lock.
 *
 * `recordAuditEvent` (src/server/audit/service.ts) takes that key as the LAST
 * statement of every audited write, in every domain. That makes the key an
 * implicit "end of transaction" resource, and it gives the whole codebase a
 * single consistent lock order:
 *
 *     rows first, tenant key last
 *
 * Two transactions that both obey it can block on each other, but they cannot
 * cycle. Break it in one place and that place deadlocks (40P01) against every
 * writer that still obeys it — which is most of the app.
 *
 * This was learned twice, expensively:
 *
 *  1. `checkReorder` took the key first and then UPDATEd an open draft PO,
 *     while `sendPurchaseOrder` / `updateDraftPo` / `cancelPurchaseOrder` took
 *     `FOR UPDATE` on that same draft and only reached the key via their
 *     closing audit event. Racing them deadlocked 24/24.
 *  2. The attempted fix hoisted the key to the front of every *purchasing*
 *     writer. That did not make the order total — it inverted purchasing
 *     against every other domain. `postReceipt` (key first, then `receiveStock`
 *     → `syncLinkedSellable` → UPDATE `products`) raced against `adjustStock`
 *     (UPDATE `products`, then audit) deadlocked 24/24 — a worse bug, on a more
 *     routine path, than the one being fixed.
 *
 * So purchasing does NOT pre-acquire the key. Writers that need to serialize
 * against a concurrent writer take `SELECT ... FOR UPDATE` on the row they are
 * about to change, which is both narrower and consistent with the rest of the
 * codebase.
 *
 * `lockPoNumbering` below is the single exception, and it is safe only because
 * of what it protects: an INSERT-only window. See its docstring.
 */

/**
 * Serializes the `MAX(po_number) + 1` read-then-insert window for one tenant,
 * exactly as `placeOrder` does for order numbers. Backstopped by
 * `UNIQUE (tenant_id, po_number)`, so a missed lock is a failed insert rather
 * than a duplicate.
 *
 * Safe despite the rule above because everything it covers is an INSERT of a
 * brand-new row: it never waits on a row another transaction could be holding,
 * so it cannot be the blocked half of a cycle. Call it as late as possible —
 * after any validation SELECTs, immediately before the MAX read — to keep that
 * window small.
 *
 * Do NOT reach for this to serialize an UPDATE. Take `FOR UPDATE` on the row.
 */
export async function lockPoNumbering(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);
}
