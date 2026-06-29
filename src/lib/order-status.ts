import type { OrderStatus } from "@/server/ordering/schema";

export type OrderStatusMeta = { label: string; badgeClass: string };

const MAP: Record<OrderStatus, OrderStatusMeta> = {
  pending: { label: "Pending", badgeClass: "bg-amber-100 text-amber-800 ring-1 ring-amber-600/20" },
  confirmed: { label: "Confirmed", badgeClass: "bg-blue-100 text-blue-800 ring-1 ring-blue-600/20" },
  preparing: { label: "Preparing", badgeClass: "bg-indigo-100 text-indigo-800 ring-1 ring-indigo-600/20" },
  ready: { label: "Ready", badgeClass: "bg-green-100 text-green-800 ring-1 ring-green-600/20" },
  out_for_delivery: { label: "Out for delivery", badgeClass: "bg-cyan-100 text-cyan-800 ring-1 ring-cyan-600/20" },
  completed: { label: "Completed", badgeClass: "bg-slate-100 text-slate-700 ring-1 ring-slate-500/20" },
  rejected: { label: "Rejected", badgeClass: "bg-red-100 text-red-800 ring-1 ring-red-600/20" },
  cancelled: { label: "Cancelled", badgeClass: "bg-red-100 text-red-800 ring-1 ring-red-600/20" },
};

export function orderStatusMeta(status: OrderStatus): OrderStatusMeta {
  return MAP[status] ?? { label: String(status), badgeClass: "bg-slate-100 text-slate-700 ring-1 ring-slate-500/20" };
}
