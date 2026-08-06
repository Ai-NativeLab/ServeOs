import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { issueRefund, type RefundInput } from "@/server/pos/refund";
import { PosAuthError, PosCashierError, PosForbiddenError, PosRefundError } from "@/server/pos/errors";

/** Returns money against a completed sale. Any cashier may *attempt* a refund
 *  (this route asserts only pos:sell, mirroring how the sale route asserts
 *  pos:sell and the service resolves the privileged step): issueRefund itself
 *  resolves pos:refund — or a manager's grantToken — and throws PosForbiddenError
 *  when neither is present, which this route maps to 403. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const body = (await req.json()) as Partial<Omit<RefundInput, "orderId">>;
  if (!body.clientRefundId) return NextResponse.json({ error: "Missing clientRefundId" }, { status: 400 });
  if (!body.payments?.length) return NextResponse.json({ error: "Missing refund payments" }, { status: 400 });

  try {
    const result = await issueRefund(
      {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        actorUserId: ctx.cashierUserId,
        permissions: ctx.permissions,
      },
      { ...(body as Omit<RefundInput, "orderId">), orderId: id },
    );
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof PosRefundError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
