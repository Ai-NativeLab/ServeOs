import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";

/** Gate for the prescription review queue — pharmacists and owners only. */
export async function requireRxReviewPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "rx:review");
  return ctx;
}
