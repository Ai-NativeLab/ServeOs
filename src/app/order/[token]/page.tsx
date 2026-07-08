import { headers } from "next/headers";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";
import { getWhatsappNumber } from "@/server/tenancy/settings";
import { listBranches, listDeliveryAreas } from "@/server/branches/service";
import { buildOrderWhatsappMessage, whatsappChatLink } from "@/lib/whatsapp";
import { formatMoney } from "@/lib/money";
import { formatDayTime } from "@/lib/datetime";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { StatusPoller } from "./StatusPoller";

const STEPS_DELIVERY = ["pending", "confirmed", "preparing", "ready", "out_for_delivery", "completed"];
const STEPS_PICKUP = ["pending", "confirmed", "preparing", "ready", "completed"];

export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const slug = h.get("x-tenant-slug");
  if (!slug) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Not found" />
      </main>
    );
  }

  const tenant = await getTenantBySlug(slug);
  const order = tenant ? await getOrderByToken(tenant.id, token) : null;
  if (!tenant || !order) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6">
        <EmptyState title="Order not found" />
      </main>
    );
  }

  const [whatsappNumber, branches] = await Promise.all([
    getWhatsappNumber(tenant.id),
    listBranches(tenant.id),
  ]);
  const branch = branches.find((b) => b.id === order.branchId) ?? null;
  const areas = order.fulfillmentType === "delivery" && order.deliveryAreaId
    ? await listDeliveryAreas(tenant.id, order.branchId)
    : [];
  const eta = areas.find((a) => a.id === order.deliveryAreaId)?.etaMinutes ?? null;
  const steps = order.fulfillmentType === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP;
  const currency = tenant.currency;

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-md">
        <div className="eyebrow text-muted-foreground">{tenant.name}</div>
        <h1 className="mt-1 font-display text-2xl font-extrabold text-ink">Order #{order.orderNumber}</h1>
        <p className="text-sm text-muted-foreground">
          Placed {formatDayTime(order.placedAt, tenant.timezone)}
        </p>

        {order.scheduledFor && (
          <div className="mt-3 rounded-xl bg-primary/10 px-4 py-2.5 text-sm font-semibold text-ink">
            Scheduled for {formatDayTime(order.scheduledFor, tenant.timezone)}
          </div>
        )}

        <StatusPoller
          token={token}
          slug={slug}
          initialStatus={order.status}
          steps={steps}
          terminal={["completed", "rejected", "cancelled"]}
          cancellable={order.status === "pending"}
        />

        <section className="mt-6 rounded-xl border border-border bg-card p-4">
          <div className="eyebrow text-muted-foreground">Receipt</div>
          <div className="mt-2 space-y-2">
            {order.items.map((it) => (
              <div key={it.id} className="flex justify-between gap-3 text-sm">
                <div>
                  <div className="text-ink">{it.quantity}× {it.nameEn}</div>
                  {it.selectedModifiers.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {it.selectedModifiers.map((m) => m.optionNameEn).join(", ")}
                    </div>
                  )}
                </div>
                <span className="font-mono">{formatMoney(Number(it.lineTotal), currency)}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-1 border-t border-border pt-2 text-sm text-muted-foreground">
            <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{formatMoney(Number(order.subtotal), currency)}</span></div>
            <div className="flex justify-between"><span>VAT {Number(order.vatRateSnapshot)}%</span><span className="font-mono">{formatMoney(Number(order.vatAmount), currency)}</span></div>
            {order.fulfillmentType === "delivery" && (
              <div className="flex justify-between"><span>Delivery</span><span className="font-mono">{formatMoney(Number(order.deliveryFee), currency)}</span></div>
            )}
            <div className="flex justify-between font-display font-bold text-ink">
              <span>Total</span><span className="font-mono">{formatMoney(Number(order.total), currency)}</span>
            </div>
          </div>
        </section>

        <section className="mt-4 rounded-xl border border-border bg-card p-4 text-sm">
          <div className="eyebrow text-muted-foreground">
            {order.fulfillmentType === "delivery" ? "Delivery" : "Pickup"}
          </div>
          {order.fulfillmentType === "delivery" ? (
            <p className="mt-1 text-ink">
              {order.deliveryAreaNameSnapshot}
              {eta ? ` · ~${eta} min` : ""}
              {order.deliveryAddressText && <><br /><span className="text-muted-foreground">{order.deliveryAddressText}</span></>}
            </p>
          ) : (
            <p className="mt-1 text-ink">
              {branch?.name ?? "Branch"}
              {branch?.address && <><br /><span className="text-muted-foreground">{branch.address}</span></>}
            </p>
          )}
          <p className="mt-2 text-muted-foreground">Cash · {order.paymentStatus}</p>
        </section>

        {whatsappNumber && (
          <a
            href={whatsappChatLink(
              whatsappNumber,
              buildOrderWhatsappMessage({
                orderNumber: order.orderNumber,
                fulfillmentType: order.fulfillmentType,
                items: order.items.map((it) => ({ quantity: it.quantity, nameEn: it.nameEn })),
                total: Number(order.total).toFixed(2),
              }),
            )}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block rounded-full bg-[#25D366] px-5 py-2.5 text-sm font-semibold text-white"
          >
            Send order via WhatsApp
          </a>
        )}
      </div>
    </main>
  );
}
