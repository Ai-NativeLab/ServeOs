import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { signInCashier } from "@/server/pos/cashier";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }

  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: "Missing email or password" }, { status: 400 });
  }

  try {
    const res = await signInCashier(device.tenantId, email, password);
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof PosCashierError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
