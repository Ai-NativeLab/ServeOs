import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireBillingPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser({ allowBilling: true });
  authorize(ctx.roleKeys, "billing:manage");
  return ctx;
}
