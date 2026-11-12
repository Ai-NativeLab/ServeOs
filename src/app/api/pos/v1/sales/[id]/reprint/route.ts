import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { reprintReceipt } from "@/server/pos/sales-history";
import { posAuthResponse, PosCashierError, PosForbiddenError } from "@/server/pos/errors";
import { OrderNotFoundError } from "@/server/ordering/errors";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let ctx;
  try {
    ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    if (e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  try {
    const receipt = await reprintReceipt(ctx.tenantId, id);
    return NextResponse.json(receipt);
  } catch (e) {
    if (e instanceof OrderNotFoundError) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    throw e;
  }
}
