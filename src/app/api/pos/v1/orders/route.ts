import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { PosAuthError } from "@/server/pos/errors";
import { submitPosOrder } from "@/server/pos/submit-order";
import type { PlaceOrderLine } from "@/server/ordering/service";

type Body = {
  clientOrderId?: string;
  lines?: PlaceOrderLine[];
  notes?: string;
};

export async function POST(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const body = (await req.json()) as Body;
  if (!body.clientOrderId) {
    return NextResponse.json({ error: "Missing clientOrderId" }, { status: 400 });
  }
  if (!body.lines || body.lines.length === 0) {
    return NextResponse.json({ error: "Missing lines" }, { status: 400 });
  }

  const res = await submitPosOrder(device, {
    clientOrderId: body.clientOrderId,
    lines: body.lines,
    notes: body.notes,
  });
  return NextResponse.json({ orderId: res.orderId, orderNumber: res.orderNumber });
}
