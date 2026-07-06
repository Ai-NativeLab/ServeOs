import { NextRequest, NextResponse } from "next/server";
import { redeemPairingCode } from "@/server/pos/service";
import { PosPairingError } from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  const { code } = (await req.json()) as { code?: string };
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });
  try {
    const res = await redeemPairingCode(code.trim().toUpperCase());
    return NextResponse.json(res);
  } catch (e) {
    if (e instanceof PosPairingError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
