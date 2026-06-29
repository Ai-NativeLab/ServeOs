import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { can } from "@/server/rbac/authorize";

// There's no dashboard overview screen yet, but login/register both redirect to
// "/dashboard" — so this index must resolve to a real page for every role.
// Send each role to the first section it's allowed to open.
export default async function DashboardPage() {
  const { roleKeys } = await requireDashboardUser();
  if (can(roleKeys, "orders:manage")) redirect("/dashboard/orders");
  if (can(roleKeys, "menu:manage")) redirect("/dashboard/menu");
  if (can(roleKeys, "fulfillment:manage")) redirect("/dashboard/fulfillment");
  // No dashboard permissions at all — back to login rather than a 404.
  redirect("/login");
}
