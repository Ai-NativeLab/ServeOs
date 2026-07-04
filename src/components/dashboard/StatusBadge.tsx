import { orderStatusMeta } from "@/lib/order-status";
import type { OrderStatus } from "@/server/ordering/schema";

export function StatusBadge({ status }: { status: OrderStatus }) {
  const meta = orderStatusMeta(status);
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${meta.badgeClass}`}>
      {meta.label}
    </span>
  );
}
