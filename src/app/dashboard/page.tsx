import { redirect } from "next/navigation";
import Link from "next/link";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { can } from "@/server/rbac/authorize";
import { listBranches } from "@/server/branches/service";
import { listProducts } from "@/server/catalog/service";
import { listOrders } from "@/server/ordering/service";
import { onboardingSteps } from "@/lib/onboarding";
import { orderStatusMeta } from "@/lib/order-status";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { Card } from "@/components/ui/card";
import { CheckCircle2, Circle } from "lucide-react";

export default async function DashboardHome() {
  const { tenantId, roleKeys } = await requireDashboardUser();

  // Staff (Orders is their only section) have no Home — send them to Orders.
  if (!can(roleKeys, "menu:manage") && !can(roleKeys, "fulfillment:manage")) {
    redirect("/dashboard/orders");
  }

  const [branches, products, orders] = await Promise.all([
    listBranches(tenantId),
    listProducts(tenantId),
    listOrders(tenantId, { limit: 100 }),
  ]);

  const steps = onboardingSteps({
    branchCount: branches.length,
    publishedProductCount: products.filter((p) => p.isPublished).length,
    hasOpeningHours: branches.some((b) => (b.openingHours ?? []).length > 0),
    acceptingOrders: branches.some((b) => b.acceptingOrders),
  });

  const counts = orders.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  const snapshot = (["pending", "preparing", "ready", "completed"] as const).map((s) => ({
    status: s, count: counts[s] ?? 0, meta: orderStatusMeta(s),
  }));

  return (
    <>
      <PageHeader title="Home" description="Your setup progress and a snapshot of recent orders." />

      <Card className="p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Get set up</h2>
        <ul className="space-y-2">
          {steps.map((step) => (
            <li key={step.key}>
              <Link href={step.href} className="flex items-center gap-3 text-sm hover:underline">
                {step.done
                  ? <CheckCircle2 className="size-5 text-green-600" />
                  : <Circle className="size-5 text-slate-300" />}
                <span className={step.done ? "text-muted-foreground line-through" : ""}>{step.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      <h2 className="text-sm font-semibold mb-3">Orders</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {snapshot.map((s) => (
          <Card key={s.status} className="p-4">
            <div className="text-2xl font-semibold">{s.count}</div>
            <div className={`inline-block mt-1 rounded px-2 py-0.5 text-xs ${s.meta.badgeClass}`}>{s.meta.label}</div>
          </Card>
        ))}
      </div>
    </>
  );
}
