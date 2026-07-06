import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { getTenantById } from "@/server/tenancy";
import { pendingOrderCount } from "@/server/ordering/service";
import { dashboardNavItems } from "@/components/dashboard/nav-items";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { Toaster } from "@/components/ui/sonner";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, tenantId, roleKeys } = await requireDashboardUser();
  const [tenant, pending] = await Promise.all([getTenantById(tenantId), pendingOrderCount(tenantId)]);
  const items = dashboardNavItems(roleKeys);

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <Sidebar items={items} restaurantName={tenant?.name ?? "Restaurant"} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userName={user.name}
          roleLabel={roleKeys[0] ?? "member"}
          pendingCount={pending}
          items={items}
          restaurantName={tenant?.name ?? "Restaurant"}
        />
        <main className="flex-1 p-4 md:p-6 max-w-5xl w-full mx-auto">{children}</main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
}
