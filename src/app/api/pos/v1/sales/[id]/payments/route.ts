import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { addTender, type TenderInput } from "@/server/pos/record-sale";
import { PosAuthError, PosCashierError, PosForbiddenError, PosSaleError } from "@/server/pos/errors";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let ctx;
  try {
    ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const body = (await req.json()) as Partial<TenderInput>;
  if (!body.clientPaymentId || !body.method || body.amount === undefined) {
    return NextResponse.json({ error: "Missing clientPaymentId, method, or amount" }, { status: 400 });
  }

  try {
    const receipt = await addTender(ctx, id, body as TenderInput);
    return NextResponse.json(receipt);
  } catch (e) {
    if (e instanceof PosSaleError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
