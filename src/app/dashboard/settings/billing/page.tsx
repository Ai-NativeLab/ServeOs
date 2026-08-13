import { requireBillingPermission } from "../billing-permission";
import { getActiveSubscription, getPlanForTenant, listPlans } from "@/server/subscription";
import { listBranches } from "@/server/branches/service";
import { listProducts } from "@/server/catalog/service";
import { listStaff } from "@/server/auth/staff";
import { ordersThisMonthCount } from "@/server/ordering/service";
import { listInvoicesForTenant } from "@/server/billing/service";
import { platformPayTo } from "@/server/payments/offline/platform-config";
import { requestPlanAction } from "./actions";
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
  // The upgradeRequest read is gone with the two-path CTA: the outstanding
  // invoice is now the single record of "this tenant asked for a plan", and
  // unlike tenant_settings it is visible to the admin who has to act on it.
  const [subscription, plan, branches, products, staff, ordersThisMonth, invoices, allPlans] =
    await Promise.all([
      getActiveSubscription(tenantId),
      getPlanForTenant(tenantId),
      listBranches(tenantId),
      listProducts(tenantId),
      listStaff(tenantId),
      ordersThisMonthCount(tenantId),
      listInvoicesForTenant(tenantId),
      listPlans(),
    ]);

  if (!plan || !subscription) {
    return <EmptyState title="No active plan" description="Contact support to set up billing for this restaurant." />;
  }

  const outstandingInvoice = invoices.find((inv) => inv.status === "open" || inv.status === "pending_verification");
  const outstandingPlan = outstandingInvoice ? allPlans.find((p) => p.id === outstandingInvoice.planId) : null;
  const payTo = platformPayTo();

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

      {outstandingInvoice && (
        // Not from a mockup: full accent wash = this needs action; the current-plan card below uses the quieter /60.
        <Card className="p-5 mb-6 border-primary/30 bg-gradient-to-br from-card from-40% to-accent">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h2 className="font-display text-lg font-bold text-ink">
              {outstandingPlan ? `${outstandingPlan.name} requested` : "Plan requested"}
            </h2>
            <span className="font-display text-xl font-bold">
              {Number(outstandingInvoice.amount).toFixed(2)} <span className="text-sm text-muted-foreground font-normal">{outstandingInvoice.currency}</span>
            </span>
          </div>

          {/* Sales-led, not self-serve. There is no card gateway and no way to
              confirm a transfer automatically, so the previous flow — here are
              our wallet details, now type the reference back to us — asked the
              customer to do the reconciling. A call is more honest and, at
              these prices, faster. */}
          <p className="text-sm mt-3 text-ink">
            One of our team will call you to arrange payment and switch the plan on. Nothing changes
            on your account until then.
          </p>

          {payTo.length > 0 && (
            <>
              <p className="text-sm mt-4 text-muted-foreground">
                Prefer to transfer now? Send it to any of these and mention your shop name — we will
                still call to confirm.
              </p>
              <ul className="text-sm mt-2 space-y-1">
                {payTo.map((p) => (
                  <li key={p.label} className="flex gap-2">
                    <span className="text-muted-foreground">{p.label}:</span>
                    <span className="font-mono">{p.detail}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {outstandingInvoice.status === "pending_verification" && (
            <Badge variant="outline" className="mt-4">Reference received — we will confirm shortly</Badge>
          )}
        </Card>
      )}

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
          return (
            <Card key={p.id} className={isCurrent ? "p-5 border-primary/30 bg-gradient-to-br from-card from-40% to-accent/60" : "p-5"}>
              <h3 className="font-display text-lg font-bold text-ink">{p.name}</h3>
              <p className="font-display text-2xl font-bold mt-1">
                {Number(p.priceMonthly).toFixed(0)} <span className="text-sm text-muted-foreground font-normal">{p.currency}/mo</span>
              </p>
              <ul className="text-sm text-muted-foreground mt-3 space-y-1">
                <li>{p.limits.branches} branches · {p.limits.staff} staff</li>
                <li>{p.limits.products} products</li>
                <li>{p.limits.orders_per_month.toLocaleString()} orders/month</li>
              </ul>
              {/* One path for every higher plan. There used to be two —
                  "Subscribe" raised an invoice, "Request upgrade" wrote a note
                  into tenant settings that no admin screen ever displayed — and
                  which one you got depended on whether the plan had a price.
                  Both now raise the invoice, because that is the row a rep can
                  actually see and close. */}
              {isCurrent ? (
                <Badge className="mt-4">Current plan</Badge>
              ) : isHigher ? (
                outstandingInvoice ? (
                  <Badge variant="outline" className="mt-4">Request pending</Badge>
                ) : (
                  <ToastForm
                    action={requestPlanAction.bind(null, p.id)}
                    successMessage="Requested — we'll call you to set it up"
                    className="mt-4"
                  >
                    <SubmitButton variant="outline" size="sm">Request this plan</SubmitButton>
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
