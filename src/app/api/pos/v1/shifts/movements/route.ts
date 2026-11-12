import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { recordCashMovement, type CashMovementInput } from "@/server/pos/cash-movements";
import {
  CashMovementError, NoOpenShiftError, PosAuthError, PosCashierError, PosForbiddenError,
} from "@/server/pos/errors";

export async function POST(req: NextRequest) {
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

  const body = (await req.json()) as Partial<CashMovementInput>;
  // See shifts/open: typeof admits Infinity, which JSON expresses as 1e999. The
  // service guard rejects NaN but NOT Infinity — `Infinity > 0` is true, so it
  // walked straight past the positive-magnitude check into `money()`.
  if (!body.type || typeof body.amount !== "number" || !Number.isFinite(body.amount) || !body.reasonCode) {
    return NextResponse.json({ error: "Missing type or reasonCode, or a non-finite amount" }, { status: 400 });
  }

  try {
    const movement = await recordCashMovement(ctx, {
      type: body.type,
      amount: body.amount,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      grants: body.grants,
    });
    return NextResponse.json({ movement });
  } catch (e) {
    if (e instanceof NoOpenShiftError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof CashMovementError) return NextResponse.json({ error: e.message }, { status: 400 });
    // An over-threshold pay-out with no manager grant lands here.
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
