import { NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { sendPurchaseOrder } from "@/server/purchasing/send";
import { PoNotFoundError, InvalidPoTransitionError, SupplierEmailMissingError } from "@/server/purchasing/errors";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  const { id } = await params;
  try {
    await sendPurchaseOrder(await resolvePurchasingActor(ctx), id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof PoNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof InvalidPoTransitionError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof SupplierEmailMissingError) return NextResponse.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
