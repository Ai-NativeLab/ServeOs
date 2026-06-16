import { requireOrdersPermission } from "../orders-permission";
import { listOrders } from "@/server/ordering/service";
import { OrdersTable } from "./OrdersTable";

export default async function OrdersPage() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  const initial = orders.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, customerName: o.customerName,
    fulfillmentType: o.fulfillmentType, total: o.total, status: o.status, paymentStatus: o.paymentStatus,
  }));
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Orders</h1>
      <OrdersTable initial={initial} />
    </main>
  );
}
