import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { posAuthResponse } from "@/server/pos/errors";
import { transitionStatus } from "@/server/ordering/service";
import { OrderNotFoundError } from "@/server/ordering/errors";
import { DomainError } from "@/shared/errors";
import { isUuid } from "@/lib/uuid";
import { webFingerprint } from "@/server/audit/fingerprint";
import type { OrderStatus } from "@/server/ordering/schema";

const ALLOWED: OrderStatus[] = ["confirmed", "preparing", "ready", "completed", "cancelled"];

/** Advance an order's status from the POS (accept, prepare, ready, complete). */
export async function POST(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    throw e;
  }

  const body = (await req.json()) as { orderId?: string; toStatus?: string };
  if (!isUuid(body.orderId) || !body.toStatus || !ALLOWED.includes(body.toStatus as OrderStatus)) {
    return NextResponse.json({ error: "Invalid orderId or status" }, { status: 400 });
  }

  try {
    const order = await transitionStatus(
      device.tenantId,
      body.orderId,
      body.toStatus as OrderStatus,
      device.createdByUserId,
      "POS",
      { fingerprint: webFingerprint(req) },
    );
    return NextResponse.json({ id: order.id, status: order.status });
  } catch (e) {
    // #187 review: the state machine's refusals (payment_not_verified,
    // invalid_transition) are answers for the cashier, not server faults —
    // the till shows `error` and can branch on `code`.
    if (e instanceof OrderNotFoundError) {
      return NextResponse.json({ error: e.messageFor("en"), code: e.code }, { status: 404 });
    }
    if (e instanceof DomainError) {
      return NextResponse.json({ error: e.messageFor("en"), code: e.code }, { status: 422 });
    }
    throw e;
  }
}
