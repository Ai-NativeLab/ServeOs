import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import type { Permission } from "@/server/rbac/permissions";
import { posPermissionsFor } from "./cashier";

/**
 * One row of the branch's offline auth roster. `passwordHash` is the raw
 * scrypt "salt:hash" string (see src/server/auth/password.ts) — the client
 * mirrors verification against it locally, never sends it anywhere else, and
 * must never log it. `permissions` is the exact pos:* / reconciliation:manage
 * union posPermissionsFor computes online, so an offline authorization check
 * agrees with its online counterpart.
 */
export type PosRosterUser = {
  userId: string;
  name: string;
  email: string;
  passwordHash: string;
  permissions: Permission[];
};

/**
 * The tenant's POS-capable roster: active users whose roles grant any pos:*
 * permission or reconciliation:manage. Managers/owners are included on
 * purpose — offline manager overrides (discount/void/refund authorization)
 * need them in the cached roster (accepted risk, see the offline-sync design
 * spec's threat model: a stolen till can crack an owner's password offline).
 *
 * Tenant-scoped, not branch-scoped: `users` carries no branch column and
 * signInCashier resolves the same way, so "the branch's roster" is the
 * tenant's roster — a POS user is not assigned to one branch.
 *
 * Excludes inactive users and anyone missing an email or password hash (they
 * cannot sign in online either, so there is nothing useful to mirror offline).
 */
export async function listPosUsers(tenantId: string): Promise<PosRosterUser[]> {
  const rows = await db.select().from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.status, "active")));

  const roster: PosRosterUser[] = [];
  for (const u of rows) {
    if (!u.email || !u.passwordHash) continue;
    const permissions = await posPermissionsFor(u.id);
    if (permissions.length === 0) continue; // no pos:* / reconciliation:manage on any role
    roster.push({ userId: u.id, name: u.name, email: u.email, passwordHash: u.passwordHash, permissions });
  }
  return roster;
}
