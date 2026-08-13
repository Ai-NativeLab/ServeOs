import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { passwordField } from "@/lib/validation/fields";
import { users, type User } from "./schema";
import { hashPassword, verifyPassword } from "./password";
import { loadUserRoleKeys } from "./current-user";
import { WeakPasswordError } from "./errors";

export type PlatformAdminAuthResult =
  | { ok: true; user: User }
  | { ok: false; reason: "invalid_credentials" | "not_admin" };

/**
 * Authenticates *and* authorizes a platform admin in one step.
 *
 * Both halves belong together: issuing a session to someone who passes the
 * password check but holds no `super_admin` role hands them a cookie that every
 * /admin page then refuses. That reads as a broken login rather than a missing
 * permission, which is exactly how the production outage presented.
 *
 * `tenantId IS NULL` scopes this to platform users, so a tenant member sharing
 * the address can never authenticate here.
 */
export async function authenticatePlatformAdmin(
  email: string,
  password: string,
): Promise<PlatformAdminAuthResult> {
  // Case-insensitive, like the tenant sign-in: what a user types is
  // lowercased before it gets here, but rows written before that was true may
  // hold capitals, and an exact match would strand exactly those accounts.
  const [user] = await db
    .select()
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.tenantId)))
    .limit(1);

  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, reason: "invalid_credentials" };
  }

  const roleKeys = await loadUserRoleKeys(user.id);
  if (!roleKeys.includes("super_admin")) return { ok: false, reason: "not_admin" };

  return { ok: true, user };
}

/**
 * Replaces a platform admin's password.
 *
 * Scoped to `tenantId IS NULL` for the same reason the login is: a tenant
 * member can share the address, and a rotation that silently reset the wrong
 * account would be worse than not rotating at all.
 */
export async function setPlatformAdminPassword(email: string, password: string): Promise<void> {
  // Enforced here rather than at a caller: this is the only way a platform
  // admin's password is ever set, and a super-admin credential is the single
  // most consequential secret in the system. Before this, `a` was accepted.
  const check = passwordField.safeParse(password);
  if (!check.success) throw new WeakPasswordError(check.error.issues[0].message);

  const [updated] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(password) })
    .where(and(eq(users.email, email), isNull(users.tenantId)))
    .returning();
  if (!updated) throw new Error(`No platform user with email ${email}`);
}
