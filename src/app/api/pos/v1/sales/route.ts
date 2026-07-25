import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { recordSale, type RecordSaleInput } from "@/server/pos/record-sale";
import { PosAuthError, PosCashierError, PosForbiddenError, PosSaleError } from "@/server/pos/errors";
import { TotalMismatchError, OrderValidationError, OutOfStockError } from "@/server/ordering/errors";

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

  const body = (await req.json()) as Partial<RecordSaleInput>;
  if (!body.clientOrderId) return NextResponse.json({ error: "Missing clientOrderId" }, { status: 400 });
  if (!body.lines?.length) return NextResponse.json({ error: "Missing lines" }, { status: 400 });
  if (body.expectedTotal === undefined) {
    return NextResponse.json({ error: "Missing expectedTotal" }, { status: 400 });
  }

  try {
    const receipt = await recordSale(ctx, {
      clientOrderId: body.clientOrderId,
      lines: body.lines,
      orderDiscountAmount: body.orderDiscountAmount,
      orderDiscountReason: body.orderDiscountReason,
      expectedTotal: body.expectedTotal,
      payments: body.payments ?? [],
      grants: body.grants,
      notes: body.notes,
    });
    return NextResponse.json(receipt);
  } catch (e) {
    // The register must fail loudly on a price change, never silently charge a
    // different amount. The POS re-pulls the catalog on a 409.
    if (e instanceof TotalMismatchError) {
      return NextResponse.json(
        { error: "Prices have changed — review the cart", expected: e.expected, actual: e.actual },
        { status: 409 },
      );
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof PosSaleError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof OutOfStockError || e instanceof OrderValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
