"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bike, ShoppingBag } from "lucide-react";
import type { OrderRow } from "@/server/ordering/service";
import type { TenantEventType, TenantRealtimeConfig } from "@/lib/realtime";
import { useTenantEvents, RELAXED_POLL_MS } from "@/lib/realtime-client";
import { cn } from "@/lib/utils";
import { formatDayTime } from "@/lib/datetime";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

/** #165: an offline payment awaiting verification blocks hand-over — make that
 * impossible to miss on a busy kitchen screen, not just red text. */
function PaymentBadge({ status }: { status: string }) {
  if (status === "pending_verification") {
    return (
      <span className="inline-flex items-center rounded-full border border-status-danger-fg/30 bg-status-danger-fg/10 px-2 py-0.5 text-xs font-semibold text-status-danger-fg">
        ⚠ Payment unverified
      </span>
    );
  }
  return (
    <span className={cn("text-xs font-medium", status === "paid" ? "text-status-ready-fg" : "text-status-danger-fg")}>
      {status}
    </span>
  );
}

/** A web order, a status change, or a till's queue landing after an outage —
 *  all of them change what belongs on this screen. */
const ORDER_EVENTS: TenantEventType[] = ["orders.changed", "sync.applied"];

const FILTERS: Record<string, (r: OrderRow) => boolean> = {
  all: () => true,
  pending: (r) => r.status === "pending",
  preparing: (r) => r.status === "confirmed" || r.status === "preparing",
  ready: (r) => r.status === "ready" || r.status === "out_for_delivery",
};

const EMPTY_STATE_COPY: Record<string, { title: string; description: string }> = {
  all: {
    title: "No orders yet",
    description: "New orders from your storefront will appear here automatically.",
  },
  pending: {
    title: "No pending orders",
    description: "New orders needing confirmation will show up here.",
  },
  preparing: {
    title: "Nothing in preparation",
    description: "Confirmed orders being prepared will show up here.",
  },
  ready: {
    title: "Nothing ready yet",
    description: "Orders ready for pickup or delivery will show up here.",
  },
};

function ScheduledChip({ iso, timezone }: { iso: string | null; timezone: string }) {
  if (!iso) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-ink">
      Scheduled · {formatDayTime(new Date(iso), timezone)}
    </span>
  );
}

/** The cadence when this table is on its own. Realtime relaxes it to
 *  RELAXED_POLL_MS, and only while the channel is actually joined. */
const POLL_MS = 8000;

export function OrdersTable({ initial, timezone, realtime }: {
  initial: OrderRow[];
  timezone: string;
  realtime: TenantRealtimeConfig | null;
}) {
  const [rows, setRows] = useState<OrderRow[]>(initial);
  const [filter, setFilter] = useState<string>("all");
  const router = useRouter();
  const pendingCount = rows.filter((r) => r.status === "pending").length;

  // The broadcast carries ids only; the rows still come from the endpoint that
  // authenticates the session and applies the tenant's RLS.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard/orders", { cache: "no-store" });
      if (res.ok) setRows(await res.json());
    } catch { /* keep polling */ }
  }, []);

  const live = useTenantEvents(realtime, ORDER_EVENTS, refresh);

  useEffect(() => {
    const id = setInterval(() => void refresh(), live ? RELAXED_POLL_MS : POLL_MS);
    return () => clearInterval(id);
  }, [refresh, live]);

  const visible = rows.filter(FILTERS[filter] ?? FILTERS.all);

  return (
    <div className="space-y-4">
      <Tabs value={filter} onValueChange={setFilter}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="pending">
            Pending{pendingCount > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{pendingCount}</span>}
          </TabsTrigger>
          <TabsTrigger value="preparing">Preparing</TabsTrigger>
          <TabsTrigger value="ready">Ready</TabsTrigger>
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <EmptyState
          title={(EMPTY_STATE_COPY[filter] ?? EMPTY_STATE_COPY.all).title}
          description={(EMPTY_STATE_COPY[filter] ?? EMPTY_STATE_COPY.all).description}
        />
      ) : (
        <>
          {/* Mobile: order cards */}
          <ul className="md:hidden space-y-2">
            {visible.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/dashboard/orders/${r.id}`}
                  className={cn("block rounded-xl border bg-card p-4", r.status === "pending" && "bg-primary/5")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm">{r.orderNumber}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-sm text-ink truncate">{r.customerName}</span>
                    <span className="font-mono text-sm">{Number(r.total).toFixed(2)}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      {r.fulfillmentType === "delivery"
                        ? <Bike className="size-3.5" strokeWidth={1.5} />
                        : <ShoppingBag className="size-3.5" strokeWidth={1.5} />}
                      {r.fulfillmentType === "delivery" ? "Delivery" : "Pickup"}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      {r.paymentStatus === "pending_verification"
                        ? <PaymentBadge status={r.paymentStatus} />
                        : <span className={cn("font-medium", r.paymentStatus === "paid" ? "text-status-ready-fg" : "text-status-danger-fg")}>{r.paymentStatus}</span>}
                    </span>
                  </div>
                  <ScheduledChip iso={r.scheduledFor} timezone={timezone} />
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <div className="hidden md:block rounded-xl border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="eyebrow">#</TableHead>
                  <TableHead className="eyebrow">Customer</TableHead>
                  <TableHead className="eyebrow">Type</TableHead>
                  <TableHead className="eyebrow text-right">Total</TableHead>
                  <TableHead className="eyebrow">Payment</TableHead>
                  <TableHead className="eyebrow">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow
                    key={r.id}
                    onClick={() => router.push(`/dashboard/orders/${r.id}`)}
                    className={cn("cursor-pointer", r.status === "pending" && "bg-primary/5")}
                  >
                    <TableCell className="font-mono text-sm">
                      <Link
                        href={`/dashboard/orders/${r.id}`}
                        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{r.customerName}</TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        {r.fulfillmentType === "delivery"
                          ? <span className="inline-flex items-center gap-1.5 text-sm"><Bike className="size-4" strokeWidth={1.5} />Delivery</span>
                          : <span className="inline-flex items-center gap-1.5 text-sm"><ShoppingBag className="size-4" strokeWidth={1.5} />Pickup</span>}
                        <ScheduledChip iso={r.scheduledFor} timezone={timezone} />
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-right">{Number(r.total).toFixed(2)}</TableCell>
                    <TableCell><PaymentBadge status={r.paymentStatus} /></TableCell>
                    <TableCell><StatusBadge status={r.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
