import Link from "next/link";
import { ArrowLeft, Bike, Clock, ShoppingBag, StickyNote } from "lucide-react";
import { requireOrdersPermission } from "../../orders-permission";
import { getOrder } from "@/server/ordering/service";
import { getSale } from "@/server/pos/sales-history";
import { nextStatuses } from "@/server/ordering/state-machine";
import { transitionOrderAction, markPaidAction } from "./actions";
import { RefundForm } from "./RefundForm";
import { can } from "@/server/rbac/authorize";
import { recordCustomerPiiView } from "@/server/audit/read-events";
import { actionAudit } from "@/server/audit/action-context";
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
  const ctx = await requireOrdersPermission();
  const tenantId = ctx.tenantId;
  const order = await getOrder(tenantId, id);
  // A staff/manager/owner viewing another party's order detail exposes customer
  // PII — log that it was viewed (the storefront's own-order view does not qualify).
  await recordCustomerPiiView(tenantId, id, await actionAudit(ctx));
  const sale = await getSale(tenantId, id);
  const tenant = await getTenantById(tenantId);
  const actions = nextStatuses(order.status, order.fulfillmentType);
  const advance = actions.filter((to) => to !== "cancelled" && to !== "rejected");
  const danger = actions.filter((to) => to === "cancelled" || to === "rejected");
  const netPaidRemaining = Math.round(
    (sale.tenders.reduce((s, t) => s + Number(t.amount), 0) -
      sale.refunds.reduce((s, r) => s + r.payments.reduce((x, p) => x + Number(p.amount), 0), 0)) * 100,
  ) / 100;
  const priorLineQtys = sale.refunds.flatMap((r) =>
    r.lines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })),
  );
  const canRefund = can(ctx.roleKeys, "pos:refund");

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
              {order.serviceChargeAmount != null && Number(order.serviceChargeAmount) > 0 && (
                <div className="flex justify-between"><span>Service charge</span><span className="font-mono">{Number(order.serviceChargeAmount).toFixed(2)}</span></div>
              )}
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

      <div className="grid gap-4 md:grid-cols-2 mb-4">
        {sale.tenders.length > 0 && (
          <Card className="p-5">
            <h2 className="eyebrow text-primary mb-3">Payments</h2>
            <div className="text-sm space-y-1.5">
              {sale.tenders.map((t) => (
                <div key={t.id} className="flex justify-between gap-2">
                  <span className="uppercase text-ink">
                    {t.method}
                    {Number(t.tipAmount) > 0 && <span className="text-muted-foreground"> + tip {Number(t.tipAmount).toFixed(2)}</span>}
                  </span>
                  <span className="font-mono">{Number(t.amount).toFixed(2)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t pt-1.5 text-muted-foreground">
                <span>Still refundable</span>
                <span className="font-mono">{netPaidRemaining.toFixed(2)}</span>
              </div>
            </div>
          </Card>
        )}

        {sale.refunds.length > 0 && (
          <Card className="p-5">
            <h2 className="eyebrow text-primary mb-3">Refunds</h2>
            <div className="space-y-3">
              {sale.refunds.map((r) => (
                <div key={r.id} className="rounded-lg border border-border bg-background p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium capitalize text-ink">
                      {r.kind} refund · {r.reasonCode.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono font-semibold text-status-danger-fg">−{Number(r.totalAmount).toFixed(2)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                    {r.authorizedByUserId ? " · manager-approved" : ""}
                    {r.reasonText ? ` · ${r.reasonText}` : ""}
                  </p>
                  {r.lines.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {r.lines.map((l) => (
                        <li key={l.id}>
                          {l.quantity}× {sale.items.find((i) => i.id === l.orderItemId)?.nameEn ?? l.orderItemId}
                          {l.restock ? " · restocked" : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {r.payments.map((p) => (
                      <li key={p.id} className="flex justify-between gap-2">
                        <span className="uppercase">{p.method}</span>
                        <span className="font-mono">{Number(p.amount).toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {canRefund && netPaidRemaining > 0.001 && order.status !== "cancelled" && order.status !== "rejected" && (
        <RefundForm
          orderId={id}
          items={sale.items.map((i) => ({ id: i.id, nameEn: i.nameEn, quantity: i.quantity, lineTotal: i.lineTotal }))}
          priorLineQtys={priorLineQtys}
          netPaidRemaining={netPaidRemaining}
        />
      )}

      <h2 className="eyebrow text-primary mb-2 mt-6">History</h2>
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
