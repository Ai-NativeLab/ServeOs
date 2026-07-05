import { requireBillingPermission } from "../billing-permission";
import { getActiveSubscription, getPlanForTenant, listPlans } from "@/server/subscription";
import { listBranches } from "@/server/branches/service";
import { listProducts } from "@/server/catalog/service";
import { listStaff } from "@/server/auth/staff";
import { ordersThisMonthCount } from "@/server/ordering/service";
import { listInvoicesForTenant } from "@/server/billing/service";
import { getUpgradeRequest } from "@/server/tenancy/settings";
import { requestUpgradeAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="eyebrow text-muted-foreground">{label}</span>
        <span className="font-display text-lg font-bold text-ink">
          {used}<span className="text-sm text-muted-foreground font-normal"> / {limit}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default async function BillingPage() {
  const { tenantId } = await requireBillingPermission();
  const [subscription, plan, branches, products, staff, ordersThisMonth, invoices, allPlans, upgradeRequest] =
    await Promise.all([
      getActiveSubscription(tenantId),
      getPlanForTenant(tenantId),
      listBranches(tenantId),
      listProducts(tenantId),
      listStaff(tenantId),
      ordersThisMonthCount(tenantId),
      listInvoicesForTenant(tenantId),
      listPlans(),
      getUpgradeRequest(tenantId),
    ]);

  if (!plan || !subscription) {
    return <EmptyState title="No active plan" description="Contact support to set up billing for this restaurant." />;
  }

  return (
    <>
      <PageHeader
        eyebrow="Billing"
        title={plan.name}
        description={
          `${Number(plan.priceMonthly).toFixed(0)} ${plan.currency}/month · ${subscription.status}` +
          (subscription.status === "trialing" && subscription.trialEndsAt
            ? ` — trial ends ${subscription.trialEndsAt.toLocaleDateString()}`
            : "")
        }
      />

      <Card className="p-5 mb-6 grid grid-cols-2 md:grid-cols-4 gap-6">
        <UsageBar label="Branches" used={branches.length} limit={plan.limits.branches} />
        <UsageBar label="Products" used={products.length} limit={plan.limits.products} />
        <UsageBar label="Staff" used={staff.length} limit={plan.limits.staff} />
        <UsageBar label="Orders this month" used={ordersThisMonth} limit={plan.limits.orders_per_month} />
      </Card>

      <h2 className="eyebrow text-primary mb-3">Invoices</h2>
      {invoices.length === 0 ? (
        <EmptyState title="No invoices yet" description="Invoices will appear here once billing starts." />
      ) : (
        <Card className="p-0 overflow-hidden mb-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Method</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell>{inv.createdAt.toLocaleDateString()}</TableCell>
                  <TableCell className="font-mono">{Number(inv.amount).toFixed(2)} {inv.currency}</TableCell>
                  <TableCell><Badge variant={inv.status === "paid" ? "default" : "outline"}>{inv.status}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{inv.method ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <h2 className="eyebrow text-primary mb-3">Plans</h2>
      <div className="grid md:grid-cols-3 gap-4">
        {allPlans.map((p) => {
          const isCurrent = p.id === plan.id;
          const isHigher = Number(p.priceMonthly) > Number(plan.priceMonthly);
          const requested = upgradeRequest?.planKey === p.key;
          return (
            <Card key={p.id} className={isCurrent ? "p-5 ring-2 ring-primary" : "p-5"}>
              <h3 className="font-display text-lg font-bold text-ink">{p.name}</h3>
              <p className="font-display text-2xl font-bold mt-1">
                {Number(p.priceMonthly).toFixed(0)} <span className="text-sm text-muted-foreground font-normal">{p.currency}/mo</span>
              </p>
              <ul className="text-sm text-muted-foreground mt-3 space-y-1">
                <li>{p.limits.branches} branches · {p.limits.staff} staff</li>
                <li>{p.limits.products} products</li>
                <li>{p.limits.orders_per_month.toLocaleString()} orders/month</li>
              </ul>
              {isCurrent ? (
                <Badge className="mt-4">Current plan</Badge>
              ) : isHigher ? (
                requested ? (
                  <Badge variant="outline" className="mt-4">
                    Requested {new Date(upgradeRequest!.requestedAt).toLocaleDateString()}
                  </Badge>
                ) : (
                  <ToastForm action={requestUpgradeAction.bind(null, p.key)} successMessage="Upgrade requested — we'll be in touch" className="mt-4">
                    <SubmitButton variant="outline" size="sm">Request upgrade</SubmitButton>
                  </ToastForm>
                )
              ) : null}
            </Card>
          );
        })}
      </div>
    </>
  );
}
