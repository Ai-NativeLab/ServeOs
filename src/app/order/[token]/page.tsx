import { headers } from "next/headers";
import { Clock, MessageCircle } from "lucide-react";
import { getTenantBySlug } from "@/server/tenancy";
import { getOrderByToken } from "@/server/ordering/service";
import { getWhatsappNumber } from "@/server/tenancy/settings";
import { tenantRealtimeConfig } from "@/server/realtime/token";
import { listBranches, listDeliveryAreas } from "@/server/branches/service";
import { getVerticalTerms, selectStorefrontTemplate, type VerticalId } from "@/server/verticals";
import { buildOrderWhatsappMessage, whatsappChatLink } from "@/lib/whatsapp";
import { formatMoney } from "@/lib/money";
import { formatDayTime } from "@/lib/datetime";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { getSaleFiscalStatusByToken } from "@/server/fiscal/read-model";
import { orderFiscalView } from "./order-fiscal";
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

  // THE COUNTRY GATE, spelled from the tenant row already in hand — the same
  // thing `@/server/fiscal/enqueue`'s `isFiscalEnabled` asserts (that function
  // is the authority; it is not called here because it would be a second query
  // for a column this page has already selected), and the same way
  // `src/app/dashboard/orders/[id]/page.tsx` spells it. Read BEFORE the fiscal
  // lookup rather than after: a non-EG storefront then issues no extra query at
  // all, so its page is unchanged in cost as well as in bytes.
  const fiscalEnabled = tenant.country === "EG";
  const [whatsappNumber, branches, fiscal] = await Promise.all([
    getWhatsappNumber(tenant.id),
    listBranches(tenant.id),
    // Token-scoped: the link the customer is holding is the whole authorisation,
    // and this read delegates to the one both-families query with its four-rung
    // precedence rather than asking its own. Deliberately NOT `listSubmissions`
    // or `getSubmissionById` — those carry `lastError`, which may legitimately
    // name a deployment env key, and this page's audience is anyone the link
    // reached.
    fiscalEnabled ? getSaleFiscalStatusByToken(tenant.id, token) : null,
  ]);
  const fiscalView = orderFiscalView({ fiscalEnabled, fiscal });
  const branch = branches.find((b) => b.id === order.branchId) ?? null;
  const areas = order.fulfillmentType === "delivery" && order.deliveryAreaId
    ? await listDeliveryAreas(tenant.id, order.branchId)
    : [];
  const eta = areas.find((a) => a.id === order.deliveryAreaId)?.etaMinutes ?? null;
  const steps = order.fulfillmentType === "delivery" ? STEPS_DELIVERY : STEPS_PICKUP;
  const currency = tenant.currency;
  const terms = getVerticalTerms(selectStorefrontTemplate(tenant.vertical as VerticalId));
  const statusOverrides = { preparing: terms.statusPreparing.en, ready: terms.statusReady.en };

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-md">
        <header className="border-b border-border pb-5">
          <div className="eyebrow text-muted-foreground">{tenant.name}</div>
          <h1 className="mt-1 font-display text-3xl font-extrabold tracking-tight text-ink">
            Order #{order.orderNumber}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Placed {formatDayTime(order.placedAt, tenant.timezone)}
          </p>
        </header>

        {order.scheduledFor && (
          <div className="mt-4 flex items-center gap-3 rounded-2xl border border-primary/15 bg-primary/10 px-4 py-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Clock className="size-4" strokeWidth={1.75} />
            </span>
            <p className="text-sm font-semibold text-ink">
              Scheduled for {formatDayTime(order.scheduledFor, tenant.timezone)}
            </p>
          </div>
        )}

        <StatusPoller
          token={token}
          slug={slug}
          initialStatus={order.status}
          steps={steps}
          terminal={["completed", "rejected", "cancelled"]}
          cancellable={order.status === "pending"}
          statusOverrides={statusOverrides}
          // Scoped to the tenant whose storefront host served this page — a
          // customer cannot ask to listen anywhere else.
          realtime={tenantRealtimeConfig(tenant.id)}
        />

        <section className="card-lift mt-6 rounded-2xl border border-border bg-card p-5">
          <div className="eyebrow text-muted-foreground">Receipt</div>
          <div className="mt-3 space-y-2">
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
          <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm text-muted-foreground">
            <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">{formatMoney(Number(order.subtotal), currency)}</span></div>
            <div className="flex justify-between"><span>VAT {Number(order.vatRateSnapshot)}%</span><span className="font-mono">{formatMoney(Number(order.vatAmount), currency)}</span></div>
            {order.serviceChargeAmount != null && Number(order.serviceChargeAmount) > 0 && (
              <div className="flex justify-between"><span>Service charge</span><span className="font-mono">{formatMoney(Number(order.serviceChargeAmount), currency)}</span></div>
            )}
            {order.fulfillmentType === "delivery" && (
              <div className="flex justify-between"><span>Delivery</span><span className="font-mono">{formatMoney(Number(order.deliveryFee), currency)}</span></div>
            )}
            <div className="flex justify-between font-display font-bold text-ink">
              <span>Total</span><span className="font-mono">{formatMoney(Number(order.total), currency)}</span>
            </div>
          </div>
        </section>

        {/*
          THE ETA BLOCK. Rendered only for an EG tenant — `fiscalView` is `null`
          for every other, so this whole section disappears and the page is
          byte-identical to the one that existed before ETA. The four states and
          the reasons behind them live in `./order-fiscal`, which is where they
          are tested; this is only their markup.

          SERVER-RENDERED, AND IT DOES NOT LIVE-UPDATE. `StatusPoller` next door
          polls `/api/orders/[token]/status` and sets its OWN state — it never
          calls `router.refresh()`, so nothing re-runs this server component
          short of a reload. That is left alone deliberately rather than fixed
          here: an online order is fiscalised by the reconciliation sweep 5-20
          minutes after payment (addendum §6), the poller stops as soon as the
          order reaches a terminal status, and no realtime event is published
          when a fiscal row is written — so there is no trigger to refresh ON,
          and inventing one would mean a new worker broadcast, a new event type
          and a refresh path — re-running this page's whole query set every few
          seconds to catch a change that usually lands after the poller has
          already stopped. The customer's reliable copy of the QR is the receipt
          email (Task 7); this block is what a revisit shows.
        */}
        {fiscalView && (
          <section className="card-lift mt-4 rounded-2xl border border-border bg-card p-5 text-sm">
            <div className="eyebrow text-muted-foreground">
              {fiscalView.kind === "invoice" || fiscalView.kind === "invoice-pending"
                ? "Tax invoice"
                : "Tax receipt"}
            </div>
            {fiscalView.kind === "receipt" && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- a
                    rendered data: URL, which the image optimizer cannot take. */}
                <img
                  src={fiscalView.qrImageDataUrl}
                  alt="ETA receipt QR code"
                  width={128}
                  height={128}
                  className="mx-auto mt-3 size-32"
                />
                {fiscalView.etaUuid && (
                  <p className="mt-2 break-all text-center text-xs text-muted-foreground">
                    ETA UUID: {fiscalView.etaUuid}
                  </p>
                )}
              </>
            )}
            {fiscalView.kind === "invoice" && (
              <p className="mt-1.5 break-all text-ink">ETA number: {fiscalView.etaLongId}</p>
            )}
            {/* THE FALLBACK IS `else`-SHAPED, not a third equality test, and
                that is what makes it total. The two branches above are the
                states that have something to SHOW (a QR, a number); everything
                else is "filed, nothing to print yet" — which is true of both
                pending kinds today and would be true of any kind added to
                `orderFiscalView` tomorrow. Enumerating `receipt-pending` and
                `invoice-pending` by name instead would leave a future kind
                rendering an eyebrow over an empty box, which reads to the
                customer as a broken page rather than as a pending document.
                Degrading to the honest pending line costs nothing and cannot
                be wrong. */}
            {fiscalView.kind !== "receipt" && fiscalView.kind !== "invoice" && (
              <p className="mt-1.5 text-muted-foreground">
                {fiscalView.kind === "invoice-pending"
                  ? "Tax invoice — pending ETA number"
                  : "Fiscal receipt pending"}
              </p>
            )}
          </section>
        )}

        <section className="card-lift mt-4 rounded-2xl border border-border bg-card p-5 text-sm">
          <div className="eyebrow text-muted-foreground">
            {order.fulfillmentType === "delivery" ? "Delivery" : "Pickup"}
          </div>
          {order.fulfillmentType === "delivery" ? (
            <p className="mt-1.5 text-ink">
              {order.deliveryAreaNameSnapshot}
              {eta ? ` · ~${eta} min` : ""}
              {order.deliveryAddressText && <><br /><span className="text-muted-foreground">{order.deliveryAddressText}</span></>}
            </p>
          ) : (
            <p className="mt-1.5 text-ink">
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
            className="card-lift mt-5 inline-flex items-center gap-2 rounded-full bg-[#25D366] px-5 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-95 active:scale-[0.98]"
          >
            <MessageCircle className="size-4" strokeWidth={2} />
            Send order via WhatsApp
          </a>
        )}
      </div>
    </main>
  );
}
