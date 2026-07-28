import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { users, type User } from "./schema";
import { verifyPassword } from "./password";
import { loadUserRoleKeys } from "./current-user";

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
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.tenantId)))
    .limit(1);

  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return { ok: false, reason: "invalid_credentials" };
  }

  const roleKeys = await loadUserRoleKeys(user.id);
  if (!roleKeys.includes("super_admin")) return { ok: false, reason: "not_admin" };

  return { ok: true, user };
}
