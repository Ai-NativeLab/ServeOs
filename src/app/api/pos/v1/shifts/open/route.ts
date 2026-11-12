import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { openShift } from "@/server/pos/shifts";
import {
  CashCountMismatchError, PosAuthError, PosCashierError, PosForbiddenError, ShiftAlreadyOpenError,
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

  const body = (await req.json()) as { openingFloat?: number; denominations?: Record<string, number> };
  // Number.isFinite, not typeof: JSON `1e999` parses to Infinity, which IS a
  // number and used to reach `money()` and store "Infinity" as the shift's
  // opening float — poisoning every variance on that shift with no way for the
  // cashier to reconcile it. money() throws on that now; this keeps a bad body
  // a 400 rather than surfacing the throw as a 500.
  if (typeof body.openingFloat !== "number" || !Number.isFinite(body.openingFloat)) {
    return NextResponse.json({ error: "openingFloat must be a finite number" }, { status: 400 });
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
