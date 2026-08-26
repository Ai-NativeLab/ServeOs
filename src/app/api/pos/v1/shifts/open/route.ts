import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { openShift } from "@/server/pos/shifts";
import {
  CashCountMismatchError, posAuthResponse, PosCashierError, PosForbiddenError, ShiftAlreadyOpenError,
} from "@/server/pos/errors";

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    if (e instanceof PosCashierError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const body = (await req.json()) as { openingFloat?: number; denominations?: Record<string, number> };
  if (typeof body.openingFloat !== "number") {
    return NextResponse.json({ error: "Missing openingFloat" }, { status: 400 });
  }

  try {
    const shift = await openShift(ctx, {
      openingFloat: body.openingFloat,
      denominations: body.denominations,
    });
    return NextResponse.json({ shift });
  } catch (e) {
    // 409: the drawer is already in a state the till must reconcile with, not a
    // malformed request.
    if (e instanceof ShiftAlreadyOpenError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof CashCountMismatchError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
