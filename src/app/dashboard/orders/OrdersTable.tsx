"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bike, ShoppingBag } from "lucide-react";
import type { OrderRow } from "@/server/ordering/service";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const FILTERS: Record<string, (r: OrderRow) => boolean> = {
  all: () => true,
  pending: (r) => r.status === "pending",
  preparing: (r) => r.status === "confirmed" || r.status === "preparing",
  ready: (r) => r.status === "ready" || r.status === "out_for_delivery",
};

export function OrdersTable({ initial }: { initial: OrderRow[] }) {
  const [rows, setRows] = useState<OrderRow[]>(initial);
  const [filter, setFilter] = useState<string>("all");
  const router = useRouter();
  const pendingCount = rows.filter((r) => r.status === "pending").length;

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch("/api/dashboard/orders", { cache: "no-store" });
        if (res.ok) setRows(await res.json());
      } catch { /* keep polling */ }
    }, 8000);
    return () => clearInterval(id);
  }, []);

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
          title={filter === "all" ? "No orders yet" : "Nothing here right now"}
          description={filter === "all"
            ? "New orders from your storefront will appear here automatically."
            : "Orders in this state will appear here."}
        />
      ) : (
        <div className="rounded-xl border bg-card overflow-hidden">
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
                  <TableCell className="font-mono text-sm">{r.orderNumber}</TableCell>
                  <TableCell>{r.customerName}</TableCell>
                  <TableCell>
                    {r.fulfillmentType === "delivery"
                      ? <span className="inline-flex items-center gap-1.5 text-sm"><Bike className="size-4" strokeWidth={1.5} />Delivery</span>
                      : <span className="inline-flex items-center gap-1.5 text-sm"><ShoppingBag className="size-4" strokeWidth={1.5} />Pickup</span>}
                  </TableCell>
                  <TableCell className="font-mono text-sm text-right">{Number(r.total).toFixed(2)}</TableCell>
                  <TableCell>
                    <span className={cn("text-xs font-medium", r.paymentStatus === "paid" ? "text-status-ready-fg" : "text-status-danger-fg")}>
                      {r.paymentStatus}
                    </span>
                  </TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
