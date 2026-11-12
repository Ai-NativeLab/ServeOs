import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier, assertPermission } from "@/server/pos/require-cashier";
import { issueRefund, type RefundInput } from "@/server/pos/refund";
import { posAuthResponse, PosCashierError, PosForbiddenError, PosRefundError } from "@/server/pos/errors";

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
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    if (e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid refund request" }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const clientRefundId = input.clientRefundId;
  const payments = input.payments;
  const lines = input.lines;

  if (typeof clientRefundId !== "string" || !clientRefundId.trim()) {
    return NextResponse.json({ error: "Missing clientRefundId" }, { status: 400 });
  }
  if (!Array.isArray(payments) || payments.length === 0) {
    return NextResponse.json({ error: "Missing refund payments" }, { status: 400 });
  }
  if (lines !== undefined && !Array.isArray(lines)) {
    return NextResponse.json({ error: "Invalid refund lines" }, { status: 400 });
  }

  try {
    const result = await issueRefund(
      {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        actorUserId: ctx.cashierUserId,
        permissions: ctx.permissions,
      },
      { ...(input as Omit<RefundInput, "orderId">), orderId: id },
    );
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof PosRefundError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
