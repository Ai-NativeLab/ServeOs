import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { posAuthResponse } from "@/server/pos/errors";

/** A device's own connectivity probe — cheap enough to poll while offline,
 *  and the signal a queued sync flush waits on before it starts sending. */
export async function GET(req: NextRequest) {
  try {
    await requirePosDevice(req);
  } catch (e) {
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    throw e;
  }
  return NextResponse.json({ ok: true, serverTime: new Date().toISOString() });
}
