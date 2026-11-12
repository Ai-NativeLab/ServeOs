import { REALTIME_PRIVATE_TOPICS, type TenantEvent } from "@/lib/realtime";

/**
 * One Realtime topic per tenant. Private (see REALTIME_PRIVATE_TOPICS), so the
 * uuid in the name is not what protects it — the RLS policy is.
 */
export function tenantTopic(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * The broadcast is awaited, not floated: a promise left running when a
 * serverless invocation returns is killed mid-flight. It is capped so a hung
 * Realtime endpoint costs the caller's request this much and no more —
 * subscribers still have polling, so waiting longer buys nothing.
 */
const PUBLISH_TIMEOUT_MS = 2_000;

function broadcastConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

/**
 * Fire-and-forget tenant broadcast. IDs only — subscribers refetch through
 * authenticated endpoints, so RLS/permissions are never bypassed. Failure is
 * swallowed: realtime is an accelerant, polling remains the guarantee, and no
 * user's write may fail because a broadcast did.
 *
 * Call it AFTER the owning transaction commits. A broadcast for a write that
 * then rolls back sends every subscriber to refetch a row that never existed.
 */
export async function publishTenantEvent(tenantId: string, event: TenantEvent): Promise<void> {
  const cfg = broadcastConfig();
  if (!cfg) return; // dev without realtime configured is fine
  try {
    await fetch(`${cfg.url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            topic: tenantTopic(tenantId),
            event: event.type,
            payload: { entityIds: event.entityIds },
            // Must match how subscribers join: a message published to the
            // public topic is not delivered to private joiners.
            private: REALTIME_PRIVATE_TOPICS,
          },
        ],
      }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
  } catch {
    /* deliberately swallowed */
  }
}
