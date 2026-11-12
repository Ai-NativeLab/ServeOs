import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { PosAuthError } from "@/server/pos/errors";
import { tenantRealtimeConfig } from "@/server/realtime/token";

/**
 * The till's ticket to its own tenant's Realtime topic. Device-authenticated:
 * the tenant comes from the paired device, never from the request, so a till
 * cannot ask to listen to anyone else. `{ enabled: false }` is the normal
 * answer on a deployment without realtime configured — the queue then keeps
 * its usual poll.
 */
export async function GET(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }
  const config = tenantRealtimeConfig(device.tenantId);
  return NextResponse.json(config ? { enabled: true, config } : { enabled: false });
}
