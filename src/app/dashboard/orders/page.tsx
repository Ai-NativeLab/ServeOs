import { requireOrdersPermission } from "../orders-permission";
import { listOrders, toOrderRow } from "@/server/ordering/service";
import { getTenantById } from "@/server/tenancy";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { OrdersTable } from "./OrdersTable";

export default async function OrdersPage() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  const tenant = await getTenantById(tenantId);
  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Orders"
        description="Live view of incoming and in-progress orders. Refreshes automatically."
      />
      <OrdersTable initial={orders.map(toOrderRow)} timezone={tenant?.timezone ?? "Africa/Cairo"} />
    </>
  );
}
