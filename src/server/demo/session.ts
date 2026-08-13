import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { roles, userRoles, users } from "@/server/auth/schema";
import { createSession } from "@/server/auth/session";
import { getTenantBySlug } from "@/server/tenancy";
import { VERTICAL_IDS, type VerticalId } from "@/server/verticals";
import { demoSlug, isDemoSlug } from "./entry";

/**
 * A demo dashboard session is short. Two hours is longer than anyone spends
 * looking around and far shorter than the thirty days a real login gets — a
 * token minted by an endpoint that asks for no credentials should not sit in
 * a browser for a month.
 */
const DEMO_SESSION_MS = 1000 * 60 * 60 * 2;

export type DemoSessionResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: "unknown_trade" | "no_tenant" | "no_owner" };

export function isVerticalId(value: string): value is VerticalId {
  return (VERTICAL_IDS as readonly string[]).includes(value);
}

/**
 * Signs a visitor into the demo tenant for a trade, with no credentials.
 *
 * This endpoint hands out a real dashboard session to whoever asks, so the
 * blast radius is set entirely by WHICH tenant it can reach. Two independent
 * guards keep that to the demo tenants:
 *
 *   1. `trade` is checked against VERTICAL_IDS, so the slug is built from a
 *      closed set rather than from user input.
 *   2. The resolved tenant's slug is re-checked with isDemoSlug before a
 *      token is minted. Belt and braces: if demoSlug() were ever changed to
 *      something that could collide with a real tenant, this still refuses.
 *
 * Everything a visitor then does is contained by row-level security, which
 * scopes every query to that tenant — a demo visitor cannot read or damage
 * another tenant's data. What they CAN do is deface the demo itself, which
 * is why the tenants are rebuilt nightly (see scripts/seed-demo-tenants.ts
 * --reset and .github/workflows/demo-reset.yml).
 */
export async function startDemoSession(trade: string): Promise<DemoSessionResult> {
  if (!isVerticalId(trade)) return { ok: false, reason: "unknown_trade" };

  const slug = demoSlug(trade);
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return { ok: false, reason: "no_tenant" };

  // Guard 2. getTenantBySlug was handed a slug we built, so this cannot fail
  // today — it exists so that it still cannot fail after someone edits
  // demoSlug().
  if (!isDemoSlug(tenant.slug)) return { ok: false, reason: "no_tenant" };

  // The owner by ROLE, not by a hardcoded address: the seed's owner email is
  // its own business, and a lookup keyed on it would break the moment that
  // changed.
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.tenantId, tenant.id), eq(roles.key, "owner")))
    .limit(1);
  if (!owner) return { ok: false, reason: "no_owner" };

  const expiresAt = new Date(Date.now() + DEMO_SESSION_MS);
  const token = await createSession(owner.id, "demo", expiresAt);
  return { ok: true, token, expiresAt };
}
