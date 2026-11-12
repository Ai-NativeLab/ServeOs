import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode } from "@/server/pos/service";
import { webFingerprint } from "@/server/audit/fingerprint";
import { PosPairingError, posAuthResponse } from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  const { code } = (await req.json()) as { code?: string };
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });
  try {
    const res = await redeemPairingCode(code.trim().toUpperCase(), { fingerprint: webFingerprint(req) });
    return NextResponse.json(res);
  } catch (e) {
    // A blocked tenant answers 403 tenant_blocked, like every other POS route.
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    if (e instanceof PosPairingError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
