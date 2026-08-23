import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { buildXReport, findOpenShift, recordMidShiftCount } from "@/server/pos/shifts";
import {
  CashCountMismatchError, NoOpenShiftError, PosAuthError, PosCashierError, PosForbiddenError,
  ShiftClosedError,
} from "@/server/pos/errors";
import type { PosCashierContext } from "@/server/pos/require-cashier";

async function authorize(req: NextRequest): Promise<PosCashierContext | NextResponse> {
  try {
    const ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
    return ctx;
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}

/** The X-report: a live snapshot that records nothing and never resets. */
export async function GET(req: NextRequest) {
  const ctx = await authorize(req);
  if (ctx instanceof NextResponse) return ctx;

  const shift = await findOpenShift(ctx.tenantId, ctx.deviceId);
  if (!shift) return NextResponse.json({ shift: null, report: null });

  return NextResponse.json({ shift, report: await buildXReport(ctx.tenantId, shift) });
}

/** A mid-shift count: records the count, returns the snapshot, leaves the drawer open. */
export async function POST(req: NextRequest) {
  const ctx = await authorize(req);
  if (ctx instanceof NextResponse) return ctx;

  const body = (await req.json()) as { countedTotal?: number; denominations?: Record<string, number> };
  // See shifts/open: typeof admits Infinity, which JSON expresses as 1e999.
  if (typeof body.countedTotal !== "number" || !Number.isFinite(body.countedTotal)) {
    return NextResponse.json({ error: "countedTotal must be a finite number" }, { status: 400 });
  }

  const shift = await findOpenShift(ctx.tenantId, ctx.deviceId);
  if (!shift) return NextResponse.json({ error: "No open shift on this device" }, { status: 409 });

  try {
    const count = await recordMidShiftCount(ctx, shift.id, {
      countedTotal: body.countedTotal,
      denominations: body.denominations,
    });
    return NextResponse.json({ count, report: await buildXReport(ctx.tenantId, shift) });
  } catch (e) {
    if (e instanceof ShiftClosedError || e instanceof NoOpenShiftError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof CashCountMismatchError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
