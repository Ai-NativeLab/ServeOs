import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { recordSale, type RecordSaleInput } from "@/server/pos/record-sale";
import { listSales, endOfDay, type SalesFilters } from "@/server/pos/sales-history";
import { posAuthResponse, NoOpenShiftError, PosCashierError, PosForbiddenError, PosSaleError } from "@/server/pos/errors";
import { TotalMismatchError, OrderValidationError, OutOfStockError } from "@/server/ordering/errors";

/** Sales-history search: only pos:sell is needed to LOOK a sale up — returning
 *  money is the privileged step, resolved inside issueRefund. */
export async function GET(req: NextRequest) {
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

  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  const orderNumber = sp.get("orderNumber");
  const amount = sp.get("amount");
  const page = sp.get("page");
  const dateFrom = from ? new Date(from) : undefined;
  const dateTo = to ? endOfDay(to) : undefined;
  const numOrderNumber = orderNumber !== null ? Number(orderNumber) : undefined;
  const numAmount = amount !== null ? Number(amount) : undefined;
  const numPage = page !== null ? Number(page) : undefined;
  if (numOrderNumber !== undefined && Number.isNaN(numOrderNumber)) {
    return NextResponse.json({ error: "Invalid orderNumber" }, { status: 400 });
  }
  if (numAmount !== undefined && Number.isNaN(numAmount)) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }
  if (numPage !== undefined && (Number.isNaN(numPage) || numPage < 1)) {
    return NextResponse.json({ error: "Invalid page" }, { status: 400 });
  }
  if ((dateFrom !== undefined && Number.isNaN(dateFrom.getTime())) || (dateTo !== undefined && Number.isNaN(dateTo.getTime()))) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const filters: SalesFilters = {
    dateFrom,
    dateTo,
    cashierUserId: sp.get("cashier") ?? undefined,
    customerPhone: sp.get("phone") ?? undefined,
    orderNumber: numOrderNumber,
    amount: numAmount,
    branchId: sp.get("branchId") ?? undefined,
    page: numPage,
  };
  const sales = await listSales(ctx.tenantId, filters);
  return NextResponse.json(sales);
}

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
    // 409, like the stale-total case: the till must open a drawer and retry,
    // not treat this as a malformed sale.
    if (e instanceof NoOpenShiftError) {
      return NextResponse.json({ error: "Open a shift before taking cash" }, { status: 409 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof PosSaleError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof OutOfStockError || e instanceof OrderValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
