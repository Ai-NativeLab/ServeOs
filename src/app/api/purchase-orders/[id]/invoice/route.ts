import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { enterInvoiceTotal } from "@/server/purchasing/variance";
import { PoNotFoundError, NoBranchError } from "@/server/purchasing/errors";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const invoiceTotal = Number(body.invoiceTotal);
  if (!Number.isFinite(invoiceTotal) || invoiceTotal < 0) {
    return NextResponse.json({ error: "invoiceTotal must be a non-negative finite number" }, { status: 400 });
  }
  try {
    await enterInvoiceTotal(await resolvePurchasingActor(ctx), id, invoiceTotal);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof NoBranchError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof PoNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
