import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "./session";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";
import { assertSuperAdmin } from "./require-role";
import { NotSignedInError, isAdminAuthError } from "./errors";
import type { User } from "./schema";

/**
 * Returns the current platform super-admin user, or throws if not signed in /
 * not authorized. Server Actions want this variant — they need the throw.
 */
export async function requireSuperAdmin(): Promise<User> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session) throw new NotSignedInError();
  const roleKeys = await loadUserRoleKeys(session.user.id);
  assertSuperAdmin(roleKeys);
  return session.user;
}

/**
 * Page/layout-safe variant. An *expected* auth failure (signed out, or missing
 * the super_admin role) becomes a redirect to the login form. Anything else —
 * a DB outage, schema drift, a bug — keeps throwing so `admin/error.tsx` shows
 * it with a digest.
 *
 * Every admin page must use this rather than bare `requireSuperAdmin`: layouts
 * and pages render in parallel, so a layout that catches on its own does not
 * stop a sibling page from throwing an unhandled render error.
 */
export async function requireSuperAdminOrRedirect(): Promise<User> {
  try {
    return await requireSuperAdmin();
  } catch (e) {
    if (isAdminAuthError(e)) redirect("/admin/login");
    throw e;
  }
}
