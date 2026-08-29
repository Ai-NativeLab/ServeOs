import { requireDashboardUser, authorizeDashboardOrRedirect } from "@/server/auth/dashboard-context";
import type { DashboardContext } from "@/server/auth/dashboard-context";

export async function requireBillingPermission(): Promise<DashboardContext> {
  // Billing is the suspension RECOVERY path: reachable while suspended, never
  // for rejected/onboarding tenants. The settings layout deliberately lets a
  // suspended tenant through to render chrome; this wrapper re-denies every
  // other settings page's default and opens only here.
  const ctx = await requireDashboardUser({ allowSuspended: true });
  await authorizeDashboardOrRedirect(ctx, "billing:manage");
  return ctx;
}
