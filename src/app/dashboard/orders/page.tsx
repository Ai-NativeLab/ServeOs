import { requireOrdersPermission } from "../orders-permission";
import { listOrders, toOrderRow } from "@/server/ordering/service";
import { OrdersTable } from "./OrdersTable";

export default async function OrdersPage() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  const initial = orders.map(toOrderRow);
  return (
    <main style={{ padding: 32, fontFamily: "system-ui" }}>
      <h1>Orders</h1>
      <OrdersTable initial={initial} />
    </main>
  );
}
