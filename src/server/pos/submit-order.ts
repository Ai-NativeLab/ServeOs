import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { placeOrder, markPaid, type PlaceOrderLine } from "@/server/ordering/service";
import { posOrderReceipts } from "./schema";

export type PosDeviceContext = {
  deviceId: string;
  tenantId: string;
  branchId: string;
  createdByUserId?: string;
};

export type SubmitPosOrderInput = {
  clientOrderId: string;
  lines: PlaceOrderLine[];
  notes?: string;
};

export type SubmitPosOrderResult = {
  orderId: string;
  orderNumber: string;
  idempotent: boolean;
};

/**
 * Idempotent POS order submission: if a receipt already exists for
 * (deviceId, clientOrderId) return it; otherwise place + markPaid and record
 * the receipt. `pos_order_receipts` has no RLS, so it is read/written through
 * the raw `db` client; `placeOrder`/`markPaid` manage their own tenant context.
 */
export async function submitPosOrder(
  device: PosDeviceContext,
  input: SubmitPosOrderInput,
): Promise<SubmitPosOrderResult> {
  const [existing] = await db
    .select({ orderId: posOrderReceipts.orderId, orderNumber: posOrderReceipts.orderNumber })
    .from(posOrderReceipts)
    .where(and(
      eq(posOrderReceipts.deviceId, device.deviceId),
      eq(posOrderReceipts.clientOrderId, input.clientOrderId),
    ))
    .limit(1);

  if (existing) {
    return { orderId: existing.orderId, orderNumber: existing.orderNumber, idempotent: true };
  }

  const placed = await placeOrder(device.tenantId, {
    branchId: device.branchId,
    fulfillmentType: "pickup",
    customerName: "Walk-in",
    customerPhone: "000000000",
    notes: input.notes,
    lines: input.lines,
  });

  await markPaid(device.tenantId, placed.orderId, device.createdByUserId ?? device.deviceId);

  await db.insert(posOrderReceipts).values({
    deviceId: device.deviceId,
    clientOrderId: input.clientOrderId,
    orderId: placed.orderId,
    orderNumber: String(placed.orderNumber),
  });

  return { orderId: placed.orderId, orderNumber: String(placed.orderNumber), idempotent: false };
}
