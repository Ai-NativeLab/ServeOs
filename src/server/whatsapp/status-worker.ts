import { sql, and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { whatsappStatusQueue, whatsappConversations, whatsappMessages, type WhatsappStatusQueueRow } from "./schema";
import { resolveAccountForTenant } from "./routing";
import type { WhatsAppProvider } from "./provider";

export const STATUS_MAX_ATTEMPTS = 3;
const STALL_RECLAIM_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;
/** Meta's customer-service window: replies within 24h of the customer's last
 *  inbound message are free; outside it a paid, pre-approved utility template
 *  is required — which v1 does not have, so those rows skip honestly. */
const FREE_WINDOW_MS = 24 * 60 * 60 * 1000;

type Sender = Pick<WhatsAppProvider, "send">;

/**
 * Drains the order-status queue — same discipline as the email outbox worker:
 * iterate tenants (the queue is FORCE RLS), claim with FOR UPDATE SKIP LOCKED
 * plus a stall deadline, back off exponentially, give up after the budget.
 */
export async function drainWhatsappStatus(
  provider: Sender,
  opts: { limitPerTenant?: number } = {},
): Promise<{ sent: number; skipped: number; failed: number }> {
  const limit = opts.limitPerTenant ?? 20;
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  const allTenants = await db.select({ id: tenants.id }).from(tenants);
  for (const t of allTenants) {
    const claimed = await withTenant(t.id, async (tx) => {
      const { rows } = await tx.execute<WhatsappStatusQueueRow>(sql`
        UPDATE whatsapp_status_queue SET status = 'queued',
               next_attempt_at = now() + make_interval(secs => ${STALL_RECLAIM_MS / 1000})
        WHERE id IN (
          SELECT id FROM whatsapp_status_queue
          WHERE status IN ('queued', 'failed')
            AND next_attempt_at <= now()
            AND attempts < ${STATUS_MAX_ATTEMPTS}
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING id, tenant_id AS "tenantId", order_id AS "orderId", wa_id AS "waId",
                  body, status, attempts, wamid
      `);
      return rows;
    });

    if (claimed.length === 0) continue;

    const account = await resolveAccountForTenant(t.id);
    const skipAll = account === null ? "account_unlinked" : null;

    for (const row of claimed) {
      if (skipAll) {
        await withTenant(t.id, (tx) => tx.update(whatsappStatusQueue)
          .set({ status: "skipped", skipReason: skipAll })
          .where(eq(whatsappStatusQueue.id, row.id)));
        skipped++;
        continue;
      }

      // The free-window check: the conversation's last inbound stamp.
      const [conv] = await withTenant(t.id, (tx) => tx.select().from(whatsappConversations)
        .where(and(eq(whatsappConversations.tenantId, t.id), eq(whatsappConversations.waId, row.waId)))
        .limit(1));
      const windowOpen = conv?.lastInboundAt
        && Date.now() - conv.lastInboundAt.getTime() < FREE_WINDOW_MS;
      if (!windowOpen) {
        await withTenant(t.id, (tx) => tx.update(whatsappStatusQueue)
          .set({ status: "skipped", skipReason: "template_required" })
          .where(eq(whatsappStatusQueue.id, row.id)));
        skipped++;
        continue;
      }

      try {
        const wamid = row.wamid
          ?? await provider.send(account!, row.waId, { kind: "text", body: row.body });

        await withTenant(t.id, async (tx) => {
          await tx.update(whatsappStatusQueue)
            .set({ status: "sent", wamid, sentAt: new Date() })
            .where(eq(whatsappStatusQueue.id, row.id));
          await tx.insert(whatsappMessages).values({
            tenantId: t.id, waId: row.waId, direction: "outbound",
            providerMessageId: wamid, payload: { body: row.body, kind: "order_status" },
          }).onConflictDoNothing({ target: whatsappMessages.providerMessageId });
          await recordAuditEvent(
            { tenantId: t.id, actorUserId: null, fingerprint: emptyFingerprint() },
            {
              action: "whatsapp.status_sent",
              entityType: "order",
              entityId: row.orderId,
              summary: `Order status message sent to ${row.waId}`,
              metadata: { wamid, body: row.body },
              actorType: "system",
            },
            tx,
          );
        });
        sent++;
      } catch (e) {
        const attempts = row.attempts + 1;
        await withTenant(t.id, (tx) => tx.update(whatsappStatusQueue)
          .set({
            status: "failed",
            attempts,
            nextAttemptAt: new Date(Date.now() + 2 ** attempts * BACKOFF_BASE_MS),
          })
          .where(eq(whatsappStatusQueue.id, row.id)));
        void e;
        failed++;
      }
    }
  }

  return { sent, skipped, failed };
}
