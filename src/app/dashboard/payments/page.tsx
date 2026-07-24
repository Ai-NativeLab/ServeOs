import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { listAwaitingPaymentOrders } from "@/server/ordering/service";
import { confirmOrderPaymentAction, rejectOrderPaymentAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default async function PaymentsQueuePage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "orders:manage");
  const orders = await listAwaitingPaymentOrders(ctx.tenantId);
  return (
    <>
      <PageHeader
        eyebrow="Payments"
        title="Awaiting payment confirmation"
        description="Confirm you received the transfer, then the order proceeds."
      />
      {orders.length === 0 ? (
        <EmptyState title="Nothing awaiting confirmation" />
      ) : (
        <div className="space-y-3 max-w-3xl">
          {orders.map((o) => (
            <Card key={o.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm">
                <div className="font-medium text-ink">#{o.orderNumber} · {o.customerName}</div>
                <div className="text-muted-foreground">
                  {o.paymentMethod} · ref {o.paymentReference ?? "—"} · {Number(o.total).toFixed(2)}
                </div>
                {o.paymentProofUrl && (
                  <a href={o.paymentProofUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    View screenshot
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                <ToastForm action={confirmOrderPaymentAction.bind(null, o.id)} successMessage="Payment confirmed">
                  <SubmitButton size="sm">Confirm</SubmitButton>
                </ToastForm>
                <ToastForm
                  action={rejectOrderPaymentAction.bind(null, o.id)}
                  successMessage="Payment rejected"
                  className="flex items-center gap-1.5"
                >
                  <Input name="reason" placeholder="Reason" className="h-8 w-32" />
                  <SubmitButton size="sm" variant="outline">Reject</SubmitButton>
                </ToastForm>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
