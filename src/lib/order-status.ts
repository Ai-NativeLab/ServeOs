import type { OrderStatus } from "@/server/ordering/schema";

export type OrderStatusMeta = { label: string; badgeClass: string };

const badge = (token: string) =>
  `bg-status-${token}/15 text-status-${token}-fg ring-1 ring-status-${token}/30`;

const MAP: Record<OrderStatus, OrderStatusMeta> = {
  pending: { label: "Pending", badgeClass: badge("pending") },
  confirmed: { label: "Confirmed", badgeClass: badge("confirmed") },
  preparing: { label: "Preparing", badgeClass: badge("preparing") },
  ready: { label: "Ready", badgeClass: badge("ready") },
  out_for_delivery: { label: "Out for delivery", badgeClass: badge("delivery") },
  completed: { label: "Completed", badgeClass: badge("completed") },
  rejected: { label: "Rejected", badgeClass: badge("danger") },
  cancelled: { label: "Cancelled", badgeClass: badge("danger") },
};

export type StatusLabelOverrides = { preparing?: string; ready?: string };

export function orderStatusMeta(status: OrderStatus, overrides?: StatusLabelOverrides): OrderStatusMeta {
  const base = MAP[status] ?? { label: String(status), badgeClass: badge("completed") };
  if (status === "preparing" && overrides?.preparing) return { ...base, label: overrides.preparing };
  if (status === "ready" && overrides?.ready) return { ...base, label: overrides.ready };
  return base;
}
