import { NextResponse } from "next/server";
import { requireOrdersPermission } from "@/app/dashboard/orders-permission";
import { listOrders, toOrderRow } from "@/server/ordering/service";

export async function GET() {
  const { tenantId } = await requireOrdersPermission();
  const orders = await listOrders(tenantId, { limit: 100 });
  return NextResponse.json(orders.map(toOrderRow));
}
