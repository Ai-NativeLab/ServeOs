import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import type { ParsedEmailEvent } from "@/server/email/provider";
import { emailEvents, notificationOutbox } from "./schema";
import { notify } from "./service";

/**
 * Records one provider delivery event. Deduped on (provider, providerEventId) —
 * a retried webhook delivery is a no-op second insert and reports duplicate so
 * the route can 200 it away.
 *
 * A bounce/complaint additionally surfaces on the matching outbox row and
 * raises an owner alert: a dead supplier address should get fixed, not
 * silently eat every future PO. The outbox is FORCE RLS and the webhook
 * carries no tenant, so the row is located by iterating the control-plane
 * tenants table — bounded and rare (bounces only).
 */
export async function recordEmailEvent(evt: ParsedEmailEvent): Promise<{ duplicate: boolean }> {
  const inserted = await db.insert(emailEvents).values({
    provider: evt.provider,
    providerMessageId: evt.providerMessageId,
    providerEventId: evt.providerEventId,
    eventType: evt.eventType,
    raw: evt.raw,
  }).onConflictDoNothing().returning({ id: emailEvents.id });
  if (inserted.length === 0) return { duplicate: true };

  if (evt.eventType === "bounced" || evt.eventType === "complained") {
    const allTenants = await db.select({ id: tenants.id }).from(tenants);
    for (const t of allTenants) {
      const updated = await withTenant(t.id, async (tx) => {
        const [row] = await tx.update(notificationOutbox)
          .set({ lastError: `provider reported ${evt.eventType}` })
          .where(eq(notificationOutbox.providerMessageId, evt.providerMessageId))
          .returning();
        if (row) {
          await notify({ tenantId: t.id }, {
            type: "system_alert", severity: "critical",
            title: `Email to ${row.toEmail} ${evt.eventType === "bounced" ? "bounced" : "was marked as spam"}`,
            body: `"${row.subject}" did not reach ${row.toEmail}. Fix the address before the next send.`,
            entityType: "notification_outbox", entityId: row.id,
            targets: [{ role: "owner" }], channels: ["in_app"],
          }, tx);
        }
        return Boolean(row);
      });
      if (updated) break;
    }
  }

  return { duplicate: false };
}
