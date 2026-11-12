import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { signInCashier } from "@/server/pos/cashier";
import { webFingerprint } from "@/server/audit/fingerprint";
import { posAuthResponse } from "@/server/pos/errors";
import { PosCashierError } from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    // The one POS surface a human reads during auth: a blocked tenant gets the
    // reason (403), not a bare 401 (#164).
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    throw e;
  }

  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: "Missing email or password" }, { status: 400 });
  }

  try {
    const res = await signInCashier(device.tenantId, email, password, { fingerprint: webFingerprint(req) });
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof PosCashierError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
