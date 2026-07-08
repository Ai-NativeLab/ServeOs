"use client";
import { useEffect, useState } from "react";
import { loadRecentOrders, updateRecentOrderStatus, type RecentOrder } from "../recent-orders";

export function RecentOrderStrip({ slug }: { slug: string }) {
  const [orders, setOrders] = useState<RecentOrder[]>([]);

  useEffect(() => {
    const current = loadRecentOrders();
    setOrders(current);
    // Refresh each entry's status once per page view; prune on the next load.
    current.forEach((o) => {
      fetch(`/api/orders/${o.token}/status?slug=${encodeURIComponent(slug)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.status && updateRecentOrderStatus(o.token, d.status))
        .catch(() => {});
    });
  }, [slug]);

  if (orders.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pt-4 sm:px-6">
      {orders.map((o) => (
        <a
          key={o.token}
          href={`/order/${o.token}`}
          className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-2.5 text-sm shadow-sm transition-shadow hover:shadow-md"
        >
          <span className="font-sans font-semibold text-ink">Your order · #{o.orderNumber}</span>
          <span className="text-muted-foreground">{o.status ?? "view"} →</span>
        </a>
      ))}
    </div>
  );
}
