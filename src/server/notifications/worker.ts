import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { recordAuditEvent } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import type { EmailProvider } from "@/server/email/provider";
import { notificationOutbox, type NotificationOutboxRow } from "./schema";
import { notify } from "./service";
import { eq } from "drizzle-orm";

export const MAX_ATTEMPTS = 5;
/** A claimed row that neither flipped nor failed within this window is
 *  considered stalled (worker crash) and becomes reclaimable. */
const STALL_RECLAIM_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MS = 30 * 1000;

/**
 * Drains the email outbox through the provider — the impure half of the
 * store-and-forward design. The outbox is FORCE RLS, so the drain iterates
 * tenants (the control-plane table) and claims inside withTenant per tenant.
 *
 * At-most-once: the claim UPDATE uses FOR UPDATE SKIP LOCKED so two workers
 * never hold the same row; the provider call carries the row id as an
 * idempotency key so a crash-after-accept retry cannot become a second email;
 * a stalled row that already carries providerMessageId flips to sent without
 * another provider call.
 */
export async function drainOutbox(
  provider: EmailProvider,
  opts: { limitPerTenant?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const limit = opts.limitPerTenant ?? 20;
  let sent = 0;
  let failed = 0;

  const allTenants = await db.select({ id: tenants.id }).from(tenants);
  for (const t of allTenants) {
    // Claim: flip eligible rows to `sending` and stamp the stall deadline, in
    // one statement, skipping rows another worker holds.
    const claimed = await withTenant(t.id, async (tx) => {
      const { rows } = await tx.execute<NotificationOutboxRow>(sql`
        UPDATE notification_outbox SET status = 'sending',
               next_attempt_at = now() + make_interval(secs => ${STALL_RECLAIM_MS / 1000})
        WHERE id IN (
          SELECT id FROM notification_outbox
          WHERE status IN ('queued', 'failed', 'sending')
            AND next_attempt_at <= now()
            AND attempts < ${MAX_ATTEMPTS}
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        RETURNING id, tenant_id AS "tenantId", to_email AS "toEmail", reply_to AS "replyTo",
                  subject, template, payload, status, attempts,
                  provider_message_id AS "providerMessageId"
      `);
      return rows;
    });

    for (const row of claimed) {
      try {
        // Crash-window recovery: the provider already accepted this one.
        const providerMessageId = row.providerMessageId
          ?? (await provider.send({
            from: process.env.EMAIL_FROM ?? "no-reply@mail.serveos.com",
            replyTo: row.replyTo ?? undefined,
            to: row.toEmail,
            subject: row.subject,
            html: renderTemplate(row.template, row.subject, row.payload as Record<string, unknown>),
            idempotencyKey: row.id,
          })).providerMessageId;
        const resent = row.providerMessageId !== null;

        await withTenant(t.id, async (tx) => {
          await tx.update(notificationOutbox)
            .set({ status: "sent", providerMessageId, sentAt: new Date() })
            .where(eq(notificationOutbox.id, row.id));
          await recordAuditEvent(
            { tenantId: t.id, actorUserId: null, fingerprint: emptyFingerprint() },
            {
              action: "notification.email.sent",
              entityType: "notification_outbox",
              entityId: row.id,
              summary: `Email "${row.subject}" sent to ${row.toEmail}`,
              metadata: { providerMessageId, template: row.template, recovered: resent },
              actorType: "system",
            },
            tx,
          );
        });
        sent++;
      } catch (e) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        await withTenant(t.id, async (tx) => {
          await tx.update(notificationOutbox)
            .set({
              status: "failed",
              attempts,
              lastError: e instanceof Error ? e.message : String(e),
              nextAttemptAt: new Date(Date.now() + 2 ** attempts * BACKOFF_BASE_MS),
            })
            .where(eq(notificationOutbox.id, row.id));
          if (exhausted) {
            // The layer's own failure surfaces through the layer itself.
            await notify({ tenantId: t.id }, {
              type: "system_alert", severity: "critical",
              title: "An email could not be delivered",
              body: `"${row.subject}" to ${row.toEmail} failed ${MAX_ATTEMPTS} times and will not be retried. Last error: ${e instanceof Error ? e.message : String(e)}`,
              entityType: "notification_outbox", entityId: row.id,
              targets: [{ role: "owner" }], channels: ["in_app"],
            }, tx);
          }
        });
        failed++;
      }
    }
  }

  return { sent, failed };
}

/** v1 rendering: a clean transactional shell around the payload. Spec 9 hands
 *  in fully-rendered PO documents via the payload when it arrives. */
function renderTemplate(template: string, subject: string, payload: Record<string, unknown>): string {
  // Spec 9: the caller pre-rendered a full document (PO HTML). It is trusted —
  // renderPurchaseOrderHtml escaped every interpolation at build time. Scoped to
  // the po_sent template so a future caller cannot turn the outbox into an
  // arbitrary-HTML emailer by setting a `html` payload key by accident.
  if (template === "po_sent" && typeof payload.html === "string") return payload.html;
  const rows = Object.entries(payload)
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6E6459;">${escapeHtml(k)}</td><td style="padding:4px 0;color:#1A0F0A;">${escapeHtml(String(v))}</td></tr>`)
    .join("");
  return `<!doctype html><html><body style="font-family:sans-serif;background:#FBF7F2;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid #E9E0D6;border-radius:12px;padding:24px;">
    <h2 style="margin:0 0 12px;color:#1A0F0A;">${escapeHtml(subject)}</h2>
    <table style="border-collapse:collapse;font-size:14px;">${rows}</table>
    <p style="margin:16px 0 0;color:#6E6459;font-size:12px;">Sent by ServeOS (${escapeHtml(template)})</p>
  </div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
