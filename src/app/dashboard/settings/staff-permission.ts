import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

export async function requireStaffPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "staff:invite");
  return ctx;
}
