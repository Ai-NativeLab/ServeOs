import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { getPurchaseOrder, updateDraftPo } from "@/server/purchasing/service";
import { PoNotFoundError, InvalidPoTransitionError } from "@/server/purchasing/errors";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  const { id } = await params;
  const po = await getPurchaseOrder(ctx.tenantId, id);
  if (!po) return NextResponse.json({ error: "Purchase order not found" }, { status: 404 });
  return NextResponse.json({ purchaseOrder: po });
}

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
  if (typeof body.supplierId !== "string" || !body.supplierId) {
    return NextResponse.json({ error: "supplierId is required" }, { status: 400 });
  }
  if (typeof body.branchId !== "string" || !body.branchId) {
    return NextResponse.json({ error: "branchId is required" }, { status: 400 });
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return NextResponse.json({ error: "lines must be a non-empty array" }, { status: 400 });
  }
  const lines = (body.lines as unknown[]).map((l) => {
    const row = (l ?? {}) as Record<string, unknown>;
    return {
      itemId: String(row.itemId ?? ""),
      qtyOrdered: Number(row.qtyOrdered),
      uom: String(row.uom ?? "") as never,
      unitCost: Number(row.unitCost),
      taxRate: row.taxRate !== undefined ? Number(row.taxRate) : undefined,
    };
  });
  try {
    await updateDraftPo(await resolvePurchasingActor(ctx), id, {
      supplierId: body.supplierId,
      branchId: body.branchId,
      expectedAt: typeof body.expectedAt === "string" ? new Date(body.expectedAt) : null,
      lines,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof PoNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof InvalidPoTransitionError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
