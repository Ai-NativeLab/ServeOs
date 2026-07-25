import { randomBytes } from "node:crypto";
import type { Permission } from "@/server/rbac/permissions";
import { PosForbiddenError } from "./errors";
import type { PosCashierContext } from "./require-cashier";

/** Long enough for a manager to walk over; short enough to be useless if left on screen. */
export const GRANT_TTL_MS = 2 * 60 * 1000;

type Grant = { tenantId: string; permission: Permission; authorizedByUserId: string; expiresAt: number };

const grants = new Map<string, Grant>();

export function issueGrant(tenantId: string, permission: Permission, authorizedByUserId: string): string {
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  for (const [t, g] of grants) if (g.expiresAt <= now) grants.delete(t);
  grants.set(token, { tenantId, permission, authorizedByUserId, expiresAt: now + GRANT_TTL_MS });
  return token;
}

/** Single-use. Deleting before every failure path means a token is spent whether or not it matched. */
export function consumeGrant(tenantId: string, token: string, permission: Permission): string {
  const g = grants.get(token);
  grants.delete(token);
  if (!g) throw new PosForbiddenError(permission);
  if (g.expiresAt <= Date.now()) throw new PosForbiddenError(permission);
  if (g.tenantId !== tenantId) throw new PosForbiddenError(permission);
  if (g.permission !== permission) throw new PosForbiddenError(permission);
  return g.authorizedByUserId;
}

/**
 * Who authorized this action? The cashier, if they hold the permission
 * themselves; otherwise the manager behind the grant. Throws if neither.
 * Every gated write goes through here — it is the single enforcement point.
 */
export function resolveAuthorizer(
  ctx: PosCashierContext,
  permission: Permission,
  grantToken?: string,
): string {
  if (ctx.permissions.includes(permission)) return ctx.cashierUserId;
  if (!grantToken) throw new PosForbiddenError(permission);
  return consumeGrant(ctx.tenantId, grantToken, permission);
}
