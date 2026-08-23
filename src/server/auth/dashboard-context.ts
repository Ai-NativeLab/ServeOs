import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "./session";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";
import type { User } from "./schema";
import type { RoleKey } from "@/server/rbac/permissions";
import { getTenantById } from "@/server/tenancy";
import type { Tenant } from "@/server/tenancy/schema";

export type DashboardContext = {
  user: User;
  tenantId: string;
  tenant: Tenant;
  roleKeys: RoleKey[];
};

export type DashboardAuthOptions = {
  allowBilling?: boolean;
  allowStatus?: ("onboarding" | "trial" | "active" | "suspended" | "rejected")[];
};

/**
 * Validates the session cookie, ensures user belongs to a tenant, and verifies
 * that the tenant has an active/trial status. Non-active tenants (suspended, rejected,
 * onboarding) are redirected to the lockout screen unless explicitly allowed by options.
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
    const isBillingAllowed = options?.allowBilling && status === "suspended";

    if (!isAllowedStatus && !isBillingAllowed) {
      redirect(`/dashboard/lockout?status=${status}`);
    }
  }

  return { user: session.user, tenantId: session.user.tenantId, tenant, roleKeys };
}
