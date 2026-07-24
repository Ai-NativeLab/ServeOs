import { requireBillingPermission } from "../billing-permission";
import { getActiveSubscription, getPlanForTenant, listPlans } from "@/server/subscription";
import { listBranches } from "@/server/branches/service";
import { listProducts } from "@/server/catalog/service";
import { listStaff } from "@/server/auth/staff";
import { ordersThisMonthCount } from "@/server/ordering/service";
import { listInvoicesForTenant } from "@/server/billing/service";
import { platformPayTo } from "@/server/payments/offline/platform-config";
import { getUpgradeRequest } from "@/server/tenancy/settings";
import { requestUpgradeAction, subscribeToPlanAction, submitInvoiceProofAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
        <Card className="p-5 mb-6 ring-2 ring-primary">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h2 className="font-display text-lg font-bold text-ink">
              Complete your payment{outstandingPlan ? ` — ${outstandingPlan.name}` : ""}
            </h2>
            <span className="font-display text-xl font-bold">
              {Number(outstandingInvoice.amount).toFixed(2)} <span className="text-sm text-muted-foreground font-normal">{outstandingInvoice.currency}</span>
            </span>
          </div>

          {payTo.length > 0 ? (
            <ul className="text-sm mt-3 space-y-1">
              {payTo.map((p) => (
                <li key={p.label} className="flex gap-2">
                  <span className="text-muted-foreground">{p.label}:</span>
                  <span className="font-mono">{p.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground mt-3">
              Pay-to details aren&apos;t configured yet — contact us to complete this payment.
            </p>
          )}

          {outstandingInvoice.status === "pending_verification" ? (
            <Badge variant="outline" className="mt-4">Reference submitted — awaiting confirmation</Badge>
          ) : (
            <ToastForm
              action={submitInvoiceProofAction.bind(null, outstandingInvoice.id)}
              successMessage="Reference submitted — awaiting confirmation"
              className="grid gap-3 mt-4 max-w-sm"
            >
              <div className="grid gap-1.5">
                <Label htmlFor="reference">Payment reference</Label>
                <Input id="reference" name="reference" placeholder="e.g. InstaPay transaction ID" required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="screenshotUrl">Screenshot URL (optional)</Label>
                <Input id="screenshotUrl" name="screenshotUrl" placeholder="https://…" />
              </div>
              <div>
                <SubmitButton size="sm">Submit reference</SubmitButton>
              </div>
            </ToastForm>
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
          const isPaid = Number(p.priceMonthly) > 0;
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
              ) : isHigher && isPaid ? (
                outstandingInvoice ? (
                  <Badge variant="outline" className="mt-4">Payment pending</Badge>
                ) : (
                  <ToastForm
                    action={subscribeToPlanAction.bind(null, p.id)}
                    successMessage="Invoice created — see payment details above"
                    className="mt-4"
                  >
                    <SubmitButton variant="outline" size="sm">Subscribe</SubmitButton>
                  </ToastForm>
                )
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
