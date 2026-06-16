import { NextResponse } from "next/server";
import { requireOrdersPermission } from "@/app/dashboard/orders-permission";
import { listOrders } from "@/server/ordering/service";

export async function GET() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  return NextResponse.json(orders.map((o) => ({
    id: o.id, orderNumber: o.orderNumber, customerName: o.customerName,
    fulfillmentType: o.fulfillmentType, total: o.total, status: o.status, paymentStatus: o.paymentStatus,
  })));
}
