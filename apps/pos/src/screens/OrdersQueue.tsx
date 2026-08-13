import { useCallback, useEffect, useState } from "react";
import type { OrderSummary } from "../../electron/preload";

// Next status offered per current status (POS-manageable flow).
const NEXT: Record<string, { to: string; label: string } | undefined> = {
  pending: { to: "confirmed", label: "Accept" },
  confirmed: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready", label: "Mark ready" },
  ready: { to: "completed", label: "Complete" },
  out_for_delivery: { to: "completed", label: "Complete" },
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending", confirmed: "Confirmed", preparing: "Preparing",
  ready: "Ready", out_for_delivery: "Out for delivery", completed: "Completed",
  rejected: "Rejected", cancelled: "Cancelled",
};

/** Web (online-placed) orders live only on the server — there is no local
 *  copy to fall back on, so an outage means the queue has nothing to show
 *  rather than a stale one (pos-main's getOrders already answers `[]` while
 *  offline; this notice explains why instead of just looking empty). */
export function OrdersQueue({ offline }: { offline: boolean }) {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setOrders(await window.pos.getOrders());
  }, []);

  useEffect(() => {
    if (offline) return;
    // Fetch on mount + poll; setState happens after an async fetch, not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const id = setInterval(() => void refresh(), 8000);
    return () => clearInterval(id);
  }, [refresh, offline]);

  async function advance(o: OrderSummary) {
    const next = NEXT[o.status];
    if (!next) return;
    setBusy(o.id);
    try {
      await window.pos.advanceOrder(o.id, next.to);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  if (offline) {
    return (
      <div className="grid place-items-center gap-1 py-20 text-center text-sm text-muted-foreground">
        <p className="font-medium text-ink">Web orders are unavailable offline</p>
        <p>This queue reads live from the server — it will catch up once the till reconnects.</p>
      </div>
    );
  }

  if (orders.length === 0) {
    return <div className="grid place-items-center py-20 text-sm text-muted-foreground">No orders yet.</div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-4 space-y-2">
      {orders.map((o) => {
        const next = NEXT[o.status];
        return (
          <div key={o.id} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-ink">#{o.orderNumber}</span>
                <span className={o.source === "walkin"
                  ? "rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-ink"
                  : "rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"}>
                  {o.source === "walkin" ? "Walk-in" : "Online"}
                </span>
                <span className="text-xs text-muted-foreground">{STATUS_LABEL[o.status] ?? o.status}</span>
              </div>
              <span className="font-mono text-sm text-ink">{Number(o.total).toFixed(2)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="truncate text-sm text-muted-foreground">
                {o.customerName} · {o.fulfillmentType === "delivery" ? "Delivery" : "Pickup"} · {o.paymentStatus}
              </span>
              {next && (
                <button
                  onClick={() => void advance(o)}
                  disabled={busy === o.id}
                  className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {busy === o.id ? "…" : next.label}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
