import Link from "next/link";
import { ArrowLeft, Bike, Clock, ShoppingBag, StickyNote } from "lucide-react";
import { requireOrdersPermission } from "../../orders-permission";
import { getOrder } from "@/server/ordering/service";
import { nextStatuses } from "@/server/ordering/state-machine";
import { transitionOrderAction, markPaidAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { ConfirmActionButton } from "@/components/dashboard/ConfirmActionButton";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDayTime } from "@/lib/datetime";
import { getTenantById } from "@/server/tenancy";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirm", preparing: "Start preparing", ready: "Mark ready",
  out_for_delivery: "Out for delivery", completed: "Complete",
  cancelled: "Cancel order", rejected: "Reject order",
};

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { tenantId } = await requireOrdersPermission();
  const order = await getOrder(tenantId, id);
  const tenant = await getTenantById(tenantId);
  const actions = nextStatuses(order.status, order.fulfillmentType);
  const advance = actions.filter((to) => to !== "cancelled" && to !== "rejected");
  const danger = actions.filter((to) => to === "cancelled" || to === "rejected");

  return (
    <>
      <Link href="/dashboard/orders" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Orders
      </Link>
      <PageHeader
        eyebrow="Order"
        title={`#${order.orderNumber}`}
        action={<StatusBadge status={order.status} />}
      />

      <div className="grid gap-4 md:grid-cols-2 mb-4">
        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Customer</h2>
          <div className="text-sm space-y-1.5">
            <div className="font-medium text-ink">{order.customerName}</div>
            <div className="font-mono">{order.customerPhone}</div>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {order.fulfillmentType === "delivery"
                ? <><Bike className="size-4" strokeWidth={1.5} />Delivery — {order.deliveryAreaNameSnapshot ?? ""}{order.deliveryAddressText ? `, ${order.deliveryAddressText}` : ""}</>
                : <><ShoppingBag className="size-4" strokeWidth={1.5} />Pickup</>}
            </div>
            {order.scheduledFor && (
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                <Clock className="size-4" strokeWidth={1.5} />
                Scheduled — {formatDayTime(order.scheduledFor, tenant?.timezone ?? "Africa/Cairo")}
              </div>
            )}
            <div>
              Cash ·{" "}
              <span className={cn("font-medium", order.paymentStatus === "paid" ? "text-status-ready-fg" : "text-status-danger-fg")}>
                {order.paymentStatus}
              </span>
            </div>
            {order.notes && (
              <div className="flex items-start gap-1.5 text-muted-foreground">
                <StickyNote className="size-4 mt-0.5" strokeWidth={1.5} />{order.notes}
              </div>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="eyebrow text-primary mb-3">Items</h2>
          <div className="text-sm space-y-1.5">
            {order.items.map((it) => (
              <div key={it.id} className="flex justify-between gap-2">
                <span>
                  {it.quantity}× {it.nameEn}
                  {it.selectedModifiers.length > 0 && (
                    <span className="text-muted-foreground"> ({it.selectedModifiers.map((m) => m.optionNameEn).join(", ")})</span>
                  )}
                </span>
                <span className="font-mono">{Number(it.lineTotal).toFixed(2)}</span>
              </div>
            ))}
            <div className="border-t pt-2 mt-2 space-y-1 text-muted-foreground">
              <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{Number(order.subtotal).toFixed(2)}</span></div>
              <div className="flex justify-between"><span>VAT</span><span className="font-mono">{Number(order.vatAmount).toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Delivery</span><span className="font-mono">{Number(order.deliveryFee).toFixed(2)}</span></div>
              <div className="flex justify-between items-baseline text-ink pt-1">
                <span className="font-medium">Total</span>
                <span className="font-display text-xl font-bold">{Number(order.total).toFixed(2)}</span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {advance.map((to, i) => (
          <ToastForm key={to} action={transitionOrderAction.bind(null, id, to, undefined)} successMessage={`Order marked ${to.replace(/_/g, " ")}`}>
            <SubmitButton variant={i === 0 ? "default" : "outline"}>{STATUS_LABEL[to] ?? to.replace(/_/g, " ")}</SubmitButton>
          </ToastForm>
        ))}
        {order.paymentStatus === "unpaid" && (
          <ToastForm action={markPaidAction.bind(null, id)} successMessage="Order marked paid">
            <SubmitButton variant="outline">Mark paid</SubmitButton>
          </ToastForm>
        )}
        {danger.map((to) => (
          <ConfirmActionButton
            key={to}
            action={transitionOrderAction.bind(null, id, to, "Cancelled by staff")}
            label={STATUS_LABEL[to] ?? to}
            title={`${STATUS_LABEL[to] ?? to}?`}
            description="The customer's order will be stopped. This can't be undone."
            successMessage={`Order ${to}`}
          />
        ))}
      </div>

      <h2 className="eyebrow text-primary mb-2">History</h2>
      <ul className="text-sm text-muted-foreground space-y-1">
        {order.events.map((e) => (
          <li key={e.id} className="flex gap-2">
            <span className="font-mono text-xs pt-0.5">{new Date(e.createdAt).toLocaleString()}</span>
            <span>{e.fromStatus ? `${e.fromStatus} → ` : ""}{e.toStatus}{e.reason ? ` (${e.reason})` : ""}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
