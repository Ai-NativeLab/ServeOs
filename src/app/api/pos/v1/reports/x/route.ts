import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { PosAuthError, PosCashierError, PosForbiddenError } from "@/server/pos/errors";
import { buildXReport } from "@/server/analytics/pos-reports";

/** The X report: a mid-shift peek. Operational, not paywalled — pos:sell only. */
export async function GET(req: NextRequest) {
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

  return NextResponse.json(await buildXReport(ctx));
}
