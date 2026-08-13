import { randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db } from "@/db/client";
import type { Permission } from "@/server/rbac/permissions";
import { PosForbiddenError } from "./errors";
import { posGrants } from "./schema";
import { tokenHash } from "./token-hash";

/** Long enough for a manager to walk over; short enough to be useless if left on screen. */
export const GRANT_TTL_MS = 2 * 60 * 1000;

export async function issueGrant(tenantId: string, permission: Permission, authorizedByUserId: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  // Opportunistic sweep: no cron for this control-plane table, so each issue
  // clears rows that have aged out before inserting its own.
  await db.delete(posGrants).where(lt(posGrants.expiresAt, new Date()));
  await db.insert(posGrants).values({
    tokenHash: tokenHash(token),
    tenantId,
    permission,
    authorizedByUserId,
    expiresAt: new Date(Date.now() + GRANT_TTL_MS),
  });
  return token;
}

/** Single-use. Deleting before every failure path means a token is spent whether or not it matched. */
export async function consumeGrant(tenantId: string, token: string, permission: Permission): Promise<string> {
  const [g] = await db.delete(posGrants).where(eq(posGrants.tokenHash, tokenHash(token))).returning();
  if (!g || g.expiresAt.getTime() <= Date.now() || g.tenantId !== tenantId || g.permission !== permission) {
    throw new PosForbiddenError(permission);
  }
  return g.authorizedByUserId;
}

/**
 * The slice of a cashier context `resolveAuthorizer` reads. Kept minimal so
 * non-POS actors (e.g. the refund's `RefundActor`) can authorize without a
 * full `PosCashierContext` — and without casting.
 */
export type PosAuthorizerContext = {
  tenantId: string;
  cashierUserId: string;
  permissions: Permission[];
};

/**
 * Who authorized this action? The cashier, if they hold the permission
 * themselves; otherwise the manager behind the grant. Throws if neither.
 * Every gated write goes through here — it is the single enforcement point.
 */
export async function resolveAuthorizer(
  ctx: PosAuthorizerContext,
  permission: Permission,
  grantToken?: string,
): Promise<string> {
  if (ctx.permissions.includes(permission)) return ctx.cashierUserId;
  if (!grantToken) throw new PosForbiddenError(permission);
  return consumeGrant(ctx.tenantId, grantToken, permission);
}
