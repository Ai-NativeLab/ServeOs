import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { getTenantById } from "@/server/tenancy";
import { pendingOrderCount } from "@/server/ordering/service";
import { unreadNotificationCount } from "@/server/notifications/service";
import { getVerticalTerms, selectStorefrontTemplate, type VerticalId } from "@/server/verticals";
import { dashboardNavItems } from "@/components/dashboard/nav-items";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { Toaster } from "@/components/ui/sonner";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // The shell lets blocked statuses through so it can render the lockout
  // screen for them; enforcement then happens per page via
  // requireDashboardUser()/`*-permission.ts` wrappers (default-deny). INVARIANT:
  // every dashboard page must carry its own gate — an unguarded new page is
  // reachable by suspended tenants. See the invariant note on requireDashboardUser.
  const { user, tenantId, tenant, roleKeys } = await requireDashboardUser({
    allowStatus: ["onboarding", "suspended", "rejected"],
  });
  const [pending, unread] = await Promise.all([
    pendingOrderCount(tenantId),
    unreadNotificationCount(tenantId, user.id, roleKeys),
  ]);
  const terms = getVerticalTerms(selectStorefrontTemplate(tenant?.vertical as VerticalId));
  const items = dashboardNavItems(roleKeys, terms.catalogNoun.en);

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      <Sidebar items={items} restaurantName={tenant?.name ?? "Restaurant"} />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar
          userName={user.name}
          roleLabel={roleKeys[0] ?? "member"}
          pendingCount={pending}
          unreadNotifications={unread}
          items={items}
          restaurantName={tenant?.name ?? "Restaurant"}
        />
        <main className="flex-1 p-4 md:p-6 max-w-5xl w-full mx-auto">{children}</main>
      </div>
      <Toaster richColors position="top-right" />
    </div>
  );
}
