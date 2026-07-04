import { requireOrdersPermission } from "../orders-permission";
import { listOrders, toOrderRow } from "@/server/ordering/service";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { OrdersTable } from "./OrdersTable";

export default async function OrdersPage() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Orders"
        description="Live view of incoming and in-progress orders. Refreshes automatically."
      />
      <OrdersTable initial={orders.map(toOrderRow)} />
    </>
  );
}
