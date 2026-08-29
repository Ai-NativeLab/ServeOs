import { requireDashboardUser, authorizeDashboardOrRedirect } from "@/server/auth/dashboard-context";
import type { DashboardContext } from "@/server/auth/dashboard-context";

export async function requireMenuPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  await authorizeDashboardOrRedirect(ctx, "menu:manage");
  return ctx;
}
