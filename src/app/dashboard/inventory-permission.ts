import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import type { Permission } from "@/server/rbac/permissions";

/**
 * Gates every inventory surface. Staff hold `inventory:view` and
 * `inventory:count` but never `inventory:manage` — they count shelves, they do
 * not re-cost or reconfigure stock.
 */
export async function requireInventoryPermission(perm: Permission): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, perm);
  return ctx;
}
