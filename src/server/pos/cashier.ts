import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { verifyPassword } from "@/server/auth/password";
import { loadUserRoleKeys } from "@/server/auth/current-user";
import { ROLE_PERMISSIONS, type Permission } from "@/server/rbac/permissions";
import { recordAuditEvent, type AuditFingerprint } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { PosCashierError } from "./errors";

const CASHIER_TTL_MS = 12 * 60 * 60 * 1000; // one long shift

export type CashierSession = {
  userId: string;
  tenantId: string;
  name: string;
  permissions: Permission[];
  expiresAt: number;
};

/**
 * Cashier sessions live in process memory, not the database: a counter session
 * is meant to die when the app or the server does. The device token (durable,
 * in `pos_devices`) is what survives — this only identifies the human.
 */
const sessions = new Map<string, CashierSession>();

function sweep(now: number): void {
  for (const [token, s] of sessions) if (s.expiresAt <= now) sessions.delete(token);
}

/**
 * Union of the counter permissions granted by any of the user's roles — the
 * `pos:*` family plus `reconciliation:manage`, which a manager needs at the
 * till to close another cashier's drawer or approve an over-threshold pay-out.
 */
export async function posPermissionsFor(userId: string): Promise<Permission[]> {
  const roleKeys = await loadUserRoleKeys(userId);
  const all = new Set<Permission>();
  for (const key of roleKeys) {
    for (const p of ROLE_PERMISSIONS[key] ?? []) {
      if (p.startsWith("pos:") || p === "reconciliation:manage") all.add(p);
    }
  }
  return [...all];
}

export async function signInCashier(
  tenantId: string,
  email: string,
  password: string,
  audit?: { fingerprint: AuditFingerprint },
): Promise<{ cashierToken: string; userId: string; name: string; permissions: Permission[] }> {
  const fingerprint = audit?.fingerprint ?? emptyFingerprint();
  // A failed sign-in has no user actor — record it against the tenant with a
  // null actorUserId (the attempted email is the only identifier we keep).
  const emitFailed = (reason: string) =>
    withTenant(tenantId, (tx) => recordAuditEvent(
      { tenantId, actorUserId: null, fingerprint },
      { action: "auth.login_failed", entityType: "auth", entityId: email.trim() || "unknown",
        summary: `Failed POS sign-in for ${email}`, metadata: { email, reason }, actorType: "system" },
      tx,
    ));

  const [user] = await db.select().from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email.trim())))
    .limit(1);

  if (!user?.passwordHash || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
    await emitFailed("bad_credentials");
    throw new PosCashierError();
  }

  const permissions = await posPermissionsFor(user.id);
  if (!permissions.includes("pos:sell")) {
    await emitFailed("not_a_cashier");
    throw new PosCashierError("This account is not allowed to use the POS");
  }

  const cashierToken = randomBytes(32).toString("hex");
  const now = Date.now();
  sweep(now);
  sessions.set(cashierToken, {
    userId: user.id, tenantId, name: user.name, permissions, expiresAt: now + CASHIER_TTL_MS,
  });

  await withTenant(tenantId, (tx) => recordAuditEvent(
    { tenantId, actorUserId: user.id, fingerprint },
    { action: "auth.cashier_signed_in", entityType: "user", entityId: user.id,
      summary: `${user.name} signed in to POS`, metadata: {}, actorType: "user" },
    tx,
  ));

  return { cashierToken, userId: user.id, name: user.name, permissions };
}

export function resolveCashier(token: string): CashierSession | null {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/** Verifies a manager's credentials and that they hold `permission`. Used by grants. */
export async function verifyAuthorizer(
  tenantId: string,
  email: string,
  password: string,
  permission: Permission,
): Promise<{ userId: string; name: string }> {
  const [user] = await db.select().from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email.trim())))
    .limit(1);

  if (!user?.passwordHash || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) {
    throw new PosCashierError();
  }
  const permissions = await posPermissionsFor(user.id);
  if (!permissions.includes(permission)) {
    throw new PosCashierError("This user cannot authorize that action");
  }
  return { userId: user.id, name: user.name };
}
