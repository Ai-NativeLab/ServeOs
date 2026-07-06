import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { PosAuthError } from "@/server/pos/errors";
import { transitionStatus } from "@/server/ordering/service";
import type { OrderStatus } from "@/server/ordering/schema";

const ALLOWED: OrderStatus[] = ["confirmed", "preparing", "ready", "completed", "cancelled"];

/** Advance an order's status from the POS (accept, prepare, ready, complete). */
export async function POST(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const body = (await req.json()) as { orderId?: string; toStatus?: string };
  if (!body.orderId || !body.toStatus || !ALLOWED.includes(body.toStatus as OrderStatus)) {
    return NextResponse.json({ error: "Invalid orderId or status" }, { status: 400 });
  }

  const order = await transitionStatus(
    device.tenantId,
    body.orderId,
    body.toStatus as OrderStatus,
    device.createdByUserId,
    "POS",
  );
  return NextResponse.json({ id: order.id, status: order.status });
}
