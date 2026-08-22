"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bike, ShoppingBag } from "lucide-react";
import type { OrderRow } from "@/server/ordering/service";
import { cn } from "@/lib/utils";
import { formatDayTime } from "@/lib/datetime";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState } from "@/components/dashboard/EmptyState";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export type SalesHistoryRow = OrderRow & { placedAt: string };

function PaymentStatus({ status }: { status: string }) {
  const cls =
    status === "paid" || status === "partially_paid"
      ? "text-status-ready-fg"
      : status === "refunded"
        ? "text-status-danger-fg"
        : "text-status-pending-fg";
  return <span className={cn("text-xs font-medium", cls)}>{status.replace(/_/g, " ")}</span>;
}

export function SalesHistoryTable({ initial, timezone }: { initial: SalesHistoryRow[]; timezone: string }) {
  const router = useRouter();

  if (initial.length === 0) {
    return (
      <EmptyState
        title="No sales found"
        description="Try widening the date range or clearing the search filters."
      />
    );
  }

  return (
    <>
      {/* Mobile: sale cards */}
      <ul className="md:hidden space-y-2">
        {initial.map((r) => (
          <li key={r.id}>
            <Link
              href={`/dashboard/orders/${r.id}`}
              className="block rounded-xl border bg-card p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm">{r.orderNumber}</span>
                <PaymentStatus status={r.paymentStatus} />
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
                  {formatDayTime(new Date(r.placedAt), timezone)}
                </span>
                <StatusBadge status={r.status} />
              </div>
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
              <TableHead className="eyebrow">Placed</TableHead>
              <TableHead className="eyebrow text-right">Total</TableHead>
              <TableHead className="eyebrow">Payment</TableHead>
              <TableHead className="eyebrow">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initial.map((r) => (
              <TableRow
                key={r.id}
                onClick={() => router.push(`/dashboard/orders/${r.id}`)}
                className="cursor-pointer"
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
                <TableCell className="text-sm text-muted-foreground">{formatDayTime(new Date(r.placedAt), timezone)}</TableCell>
                <TableCell className="font-mono text-sm text-right">{Number(r.total).toFixed(2)}</TableCell>
                <TableCell><PaymentStatus status={r.paymentStatus} /></TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
