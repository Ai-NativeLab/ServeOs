import { NextRequest, NextResponse } from "next/server";
import { resolveFiscalContext } from "@/app/dashboard/fiscal-permission";
import { actionAudit } from "@/server/audit/action-context";
import { requestB2bInvoice, type RequestB2bInvoiceBuyer } from "@/server/fiscal/config-service";
import { fiscalErrorResponse, redactedCause } from "../../../fiscal-errors";

/**
 * Requests a B2B tax invoice for one order, with the buyer's ETA receiver
 * details in the body.
 *
 * PATH SHAPE, and why it sits under `fiscal/` rather than under `orders/`: every
 * route in this tree is gated by the same owner-only `fiscal:manage` and mapped
 * by the same `fiscalErrorResponse` ladder, and `submissions/[id]/resubmit` is
 * already the precedent for a fiscal ACT keyed on an entity id. Filing under
 * `api/dashboard/orders/[id]/…` would have put a fiscal permission on a route
 * tree whose neighbours all carry `orders:*`.
 *
 * POST, not PUT: unlike `tax-codes/[productId]`, this is not an upsert of a row
 * the URL names. It creates a submission — at most one live one per order, which
 * is why a second call answers 409 rather than replacing anything.
 *
 * The order id comes from the PATH and the buyer from the BODY. Everything else
 * — validation, the ownership check, the live-invoice ladder, the audit event
 * and the best-effort finalize — is `requestB2bInvoice`'s, shared verbatim with
 * the dashboard's server action so neither surface can drift from the other.
 *
 * 403 no `fiscal:manage` · 400 malformed body or a buyer field · 404 not this
 * tenant's order · 409 already invoiced, previously rejected, already filed as
 * an e-receipt (one sale, one document family — see `requestB2bInvoice`), or a
 * cancelled order · 201.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolveFiscalContext();
  if (denied) return denied;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid buyer" }, { status: 400 });
  }

  try {
    const outcome = await requestB2bInvoice(
      ctx.tenantId,
      id,
      body as RequestB2bInvoiceBuyer,
      await actionAudit(ctx),
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ submissionId: outcome.submissionId }, { status: 201 });
  } catch (e) {
    const mapped = fiscalErrorResponse(e);
    if (mapped) return mapped;
    // Redacted like every sibling write route. Nothing that reaches HERE carries
    // a credential reference — the one step on this path that resolves an e-seal
    // ref is the best-effort finalize, which swallows and logs its own failures
    // inside the service and never throws this far. It is redacted anyway, for
    // the reason the resubmit route states: a uniform shape has no exception to
    // remember when someone copies this handler.
    console.error("requestB2bInvoice failed", { tenantId: ctx.tenantId, orderId: id, ...redactedCause(e) });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
