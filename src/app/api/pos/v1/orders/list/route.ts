import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { PosAuthError } from "@/server/pos/errors";
import { listOrders } from "@/server/ordering/service";

/**
 * Live order queue for the device's branch — online (storefront) and walk-in
 * (POS) orders together. Walk-in orders are the ones named "Walk-in".
 */
export async function GET(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const orders = await listOrders(device.tenantId, { branchId: device.branchId, limit: 50 });
  const rows = orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    customerName: o.customerName,
    fulfillmentType: o.fulfillmentType,
    total: String(o.total),
    status: o.status,
    paymentStatus: o.paymentStatus,
    placedAt: o.placedAt,
    source: o.customerName === "Walk-in" ? ("walkin" as const) : ("online" as const),
  }));
  return NextResponse.json({ orders: rows, syncedAt: new Date().toISOString() });
}
