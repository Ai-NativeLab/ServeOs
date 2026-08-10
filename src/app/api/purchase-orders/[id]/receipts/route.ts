import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { postReceipt } from "@/server/purchasing/receiving";
import { PoNotFoundError, InvalidPoTransitionError } from "@/server/purchasing/errors";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: "lines must be a non-empty array" }, { status: 400 });
  }
  const lines = (body.lines as unknown[]).map((l) => {
    const row = (l ?? {}) as Record<string, unknown>;
    return {
      poLineId: String(row.poLineId ?? ""),
      receivedQty: Number(row.receivedQty),
      uom: String(row.uom ?? "") as never,
      unitCost: Number(row.unitCost),
      lotCode: typeof row.lotCode === "string" ? row.lotCode : undefined,
      expiryAt: typeof row.expiryAt === "string" ? new Date(row.expiryAt) : undefined,
    };
  });
  try {
    const actor = await resolvePurchasingActor(ctx);
    const { receiptId, status } = await postReceipt(actor, id, {
      supplierDeliveryNote: typeof body.supplierDeliveryNote === "string" ? body.supplierDeliveryNote : undefined,
      note: typeof body.note === "string" ? body.note : undefined,
      lines,
    });
    return NextResponse.json({ receiptId, status }, { status: 201 });
  } catch (e) {
    if (e instanceof PoNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof InvalidPoTransitionError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
