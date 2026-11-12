import { createHmac } from "node:crypto";
import { tenantTopic } from "./publish";
import type { TenantRealtimeConfig } from "@/lib/realtime";

/**
 * A subscriber's ticket to exactly one tenant's topic.
 *
 * The platform does not use Supabase Auth, so an anon-key holder arrives at
 * Realtime with no identity at all — which is why the tenant claim has to be
 * minted here, server-side, from a session/device we already authenticated.
 * The RLS policy on `realtime.messages` compares this claim to the topic being
 * joined (docs/references/realtime.md), so a client cannot pick its own tenant
 * and cannot listen to anyone else's.
 *
 * Read-only by construction: the policy grants SELECT only, so possession of a
 * token lets you *hear* a tenant's ids and nothing more — publishing stays with
 * the service role, which no browser or till ever holds.
 */

/** One working day. On expiry Realtime drops the channel, the subscriber falls
 *  back to its normal polling cadence, and the next page load mints a fresh
 *  one — a stale tab degrades, it never breaks. */
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function mintTenantRealtimeToken(
  tenantId: string,
  nowMs: number = Date.now(),
): { token: string; expiresAt: string } | null {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  // `role` is what the RLS policy runs as; `tenant_id` is what it compares.
  const claims = b64url(JSON.stringify({
    aud: "authenticated",
    role: "authenticated",
    sub: tenantId,
    tenant_id: tenantId,
    iat,
    exp,
  }));
  const signature = createHmac("sha256", secret).update(`${header}.${claims}`).digest("base64url");
  return { token: `${header}.${claims}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Everything a subscriber needs, or null when Realtime is not configured —
 * which is the whole switch: no config, no socket, and every poller keeps
 * today's cadence.
 */
export function tenantRealtimeConfig(tenantId: string): TenantRealtimeConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const minted = mintTenantRealtimeToken(tenantId);
  if (!url || !anonKey || !minted) return null;
  return { url, anonKey, topic: tenantTopic(tenantId), token: minted.token };
}
