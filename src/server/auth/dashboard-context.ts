import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "./session";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";
import type { User } from "./schema";
import type { RoleKey } from "@/server/rbac/permissions";

export type DashboardContext = {
  user: User;
  tenantId: string;
  roleKeys: RoleKey[];
};

/**
 * Validates the session cookie and returns the current dashboard user + tenantId.
 * Redirects to /login if no valid session or user has no tenantId (super-admins).
 * Call authorize(ctx.roleKeys, permission) after this to check specific permissions.
 */
export async function requireDashboardUser(): Promise<DashboardContext> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session || !session.user.tenantId) redirect("/login");
  const roleKeys = await loadUserRoleKeys(session.user.id);
  return { user: session.user, tenantId: session.user.tenantId, roleKeys };
}
