import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { discardHeldTicket } from "@/server/pos/held-tickets";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requirePosCashier(req);
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }
  await discardHeldTicket(ctx, id);
  return NextResponse.json({ ok: true });
}
