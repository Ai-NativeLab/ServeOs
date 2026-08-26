import { requireDashboardUser, authorizeDashboardOrRedirect } from "@/server/auth/dashboard-context";
import type { DashboardContext } from "@/server/auth/dashboard-context";
import { authorize, can } from "@/server/rbac/authorize";
import { requireFeature } from "@/server/entitlements/service";

/** Gate for the reports pages. Mirrors requireMenuPermission. */
export async function requireReportsPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  await authorizeDashboardOrRedirect(ctx, "reports:view");
  return ctx;
}

/** Financial cards are computed only when this is true (server-side omission). */
export function canFinancialReports(ctx: DashboardContext): boolean {
  return can(ctx.roleKeys, "reports:financial");
}

/** Throws FeatureNotAvailableError on a base/pro plan; resolves on enterprise. */
export async function requireAdvancedReports(tenantId: string): Promise<void> {
  await requireFeature(tenantId, "advanced_analytics");
}
