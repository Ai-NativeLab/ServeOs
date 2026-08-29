import { requireDashboardUser, authorizeDashboardOrRedirect } from "@/server/auth/dashboard-context";
import type { DashboardContext } from "@/server/auth/dashboard-context";

export async function requireStaffPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  await authorizeDashboardOrRedirect(ctx, "staff:invite");
  return ctx;
}
