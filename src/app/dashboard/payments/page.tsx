import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listAwaitingPaymentOrders } from "@/server/ordering/service";
import { canTransition } from "@/server/ordering/state-machine";
import { tenantRealtimeConfig } from "@/server/realtime/token";
import { confirmOrderPaymentAction, rejectOrderPaymentAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { RealtimeRefresh } from "@/components/dashboard/RealtimeRefresh";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/** Only http(s) URLs are ever safe to render as an href — a customer-supplied
 * `javascript:`/`data:` URL would be stored XSS if a merchant clicked it. This
 * mirrors the same check enforced at write-time in placeOrder. */
const SAFE_URL_RE = /^https?:\/\//i;

export default async function PaymentsQueuePage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "payments:confirm");
  const orders = await listAwaitingPaymentOrders(ctx.tenantId);
  return (
    <>
      {/* A shared work list: an order placed by a customer, or a colleague's
          confirmation, should reach this screen without a manual reload. */}
      <RealtimeRefresh config={tenantRealtimeConfig(ctx.tenantId)} types={["orders.changed"]} />
      <PageHeader
        eyebrow="Payments"
        title="Awaiting payment confirmation"
        description="Confirm you received the transfer, then the order proceeds. Fulfilled orders cannot be cancelled — uncollected payments on completed orders must be handled via manual write-off or refund adjustments."
      />
      {orders.length === 0 ? (
        <EmptyState title="Nothing awaiting confirmation" />
      ) : (
        <div className="space-y-3 max-w-3xl">
          {orders.map((o) => {
            const canCancel = canTransition(o.status, "cancelled", o.fulfillmentType);
            return (
              <Card key={o.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium text-ink">#{o.orderNumber} · {o.customerName}</div>
                  <div className="text-muted-foreground">
                    {o.paymentMethod} · ref {o.paymentReference ?? "—"} · {Number(o.total).toFixed(2)} · <span className="capitalize">{o.status}</span>
                  </div>
                  {o.paymentProofUrl && SAFE_URL_RE.test(o.paymentProofUrl) && (
                    <a href={o.paymentProofUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      View screenshot
                    </a>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <ToastForm action={confirmOrderPaymentAction.bind(null, o.id)} successMessage="Payment confirmed">
                    <SubmitButton size="sm">Confirm</SubmitButton>
                  </ToastForm>
                  {canCancel ? (
                    <ToastForm
                      action={rejectOrderPaymentAction.bind(null, o.id)}
                      successMessage="Payment rejected"
                      className="flex items-center gap-1.5"
                    >
                      <Input name="reason" placeholder="Reason" className="h-8 w-32" />
                      <SubmitButton size="sm" variant="outline">Reject</SubmitButton>
                    </ToastForm>
                  ) : (
                    <span
                      className="rounded bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground"
                      title={`Order #${o.orderNumber} is already ${o.status} and cannot be cancelled. Unpaid completed orders should be handled as a manual write-off.`}
                    >
                      Fulfilled ({o.status}) · Write-off
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
