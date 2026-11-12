import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { closeShift, findOpenShift, type CloseShiftInput } from "@/server/pos/shifts";
import {
  CashCountMismatchError, NoOpenShiftError, PosAuthError, PosCashierError, PosForbiddenError,
  ShiftClosedError,
} from "@/server/pos/errors";

type CloseBody = Partial<CloseShiftInput> & { shiftId?: string };

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requirePosCashier(req);
    // Closing your own drawer is a cashier action; closing someone else's, or
    // settling a flagged variance, is enforced inside closeShift.
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  const body = (await req.json()) as CloseBody;
  // See shifts/open: typeof admits Infinity, which JSON expresses as 1e999.
  if (typeof body.count?.countedTotal !== "number" || !Number.isFinite(body.count.countedTotal)) {
    return NextResponse.json({ error: "count.countedTotal must be a finite number" }, { status: 400 });
  }

  const shiftId = body.shiftId ?? (await findOpenShift(ctx.tenantId, ctx.deviceId))?.id;
  if (!shiftId) return NextResponse.json({ error: "No open shift on this device" }, { status: 409 });

  try {
    const report = await closeShift(ctx, shiftId, { count: body.count, grants: body.grants });
    return NextResponse.json({ report });
  } catch (e) {
    if (e instanceof ShiftClosedError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof NoOpenShiftError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof CashCountMismatchError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
