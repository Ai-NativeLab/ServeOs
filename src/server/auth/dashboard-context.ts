import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "./session";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";
import type { User } from "./schema";
import type { RoleKey, Permission } from "@/server/rbac/permissions";
import { can } from "@/server/rbac/authorize";
import { getTenantById } from "@/server/tenancy";
import type { Tenant, tenantStatus } from "@/server/tenancy/schema";

export type TenantStatus = (typeof tenantStatus.enumValues)[number];

export type DashboardContext = {
  user: User;
  tenantId: string;
  tenant: Tenant;
  roleKeys: RoleKey[];
};

export type DashboardAuthOptions = {
  /**
   * This route is part of the SUSPENSION RECOVERY path (billing) and must stay
   * reachable while a tenant is suspended. Never exempts `rejected` or
   * `onboarding` tenants — those states have nothing to recover into.
   */
  allowSuspended?: boolean;
  /**
   * Extra statuses this specific surface may render. Used by the dashboard
   * shell (which must render the lockout screen itself) — NOT an invitation
   * for feature routes to opt out of gating.
   */
  allowStatus?: TenantStatus[];
};

/**
 * Validates the session cookie, ensures user belongs to a tenant, and verifies
 * that the tenant has an active/trial status. Non-active tenants (suspended,
 * rejected, onboarding) are redirected to the lockout screen unless explicitly
 * allowed by options.
 *
 * The status is re-read from the database on EVERY request — never cached in
 * the session — so suspending or reactivating a tenant takes effect on the
 * next navigation with no re-login (#164).
 *
 * INVARIANT the whole dashboard leans on: every page enforces its own
 * permission via requireDashboardUser() or a `*-permission.ts` wrapper. The
 * shell layout deliberately lets blocked statuses through so it can render the
 * lockout; if a new page ships without its own gate, that page is reachable by
 * suspended tenants. Do not add one bare.
 */
export async function requireDashboardUser(options?: DashboardAuthOptions): Promise<DashboardContext> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;
  if (!session || !session.user.tenantId) redirect("/login");

  const [tenant, roleKeys] = await Promise.all([
    getTenantById(session.user.tenantId),
    loadUserRoleKeys(session.user.id),
  ]);

  if (!tenant) redirect("/login");

  const status = tenant.status;
  if (status !== "active" && status !== "trial") {
    const isAllowedStatus = options?.allowStatus?.includes(status);
    const isRecoveryPath = options?.allowSuspended && status === "suspended";

    if (!isAllowedStatus && !isRecoveryPath) {
      redirect(`/dashboard/lockout?status=${status}`);
    }
  }

  return { user: session.user, tenantId: session.user.tenantId, tenant, roleKeys };
}

/**
 * PAGE-level permission gate (#172): redirects to the shared denial screen
 * instead of throwing, so a missing permission can never reach a client error
 * boundary as a stripped, unrecognisable crash � in production Next replaces
 * server-error messages with a digest, which defeats any client-side
 * "unauthorized?" heuristic.
 *
 * API routes and server ACTIONS should keep using `authorize()` (throwing) �
 * a redirect is meaningless inside a JSON response or a ToastForm action.
 */
export async function authorizeDashboardOrRedirect(
  ctx: DashboardContext,
  permission: Permission,
): Promise<void> {
  if (!can(ctx.roleKeys, permission)) {
    redirect(`/dashboard/denied?permission=${encodeURIComponent(permission)}`);
  }
}