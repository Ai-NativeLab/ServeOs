import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { getSale } from "@/server/pos/sales-history";
import { PosAuthError, PosCashierError, PosForbiddenError } from "@/server/pos/errors";
import { OrderNotFoundError } from "@/server/ordering/errors";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  try {
    const detail = await getSale(ctx.tenantId, id);
    return NextResponse.json(detail);
  } catch (e) {
    if (e instanceof OrderNotFoundError) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    throw e;
  }
}
