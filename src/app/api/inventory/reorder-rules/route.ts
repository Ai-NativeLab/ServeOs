import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { listReorderRules, upsertReorderRule } from "@/server/purchasing/reorder";
import { purchasingErrorResponse } from "../../purchasing-errors";

export async function GET() {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  const rows = await listReorderRules(ctx.tenantId);
  return NextResponse.json({ rules: rows });
}

export async function PUT(req: NextRequest) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.itemId !== "string" || !body.itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }
  if (typeof body.locationId !== "string" || !body.locationId) {
    return NextResponse.json({ error: "locationId is required" }, { status: 400 });
  }
  const reorderPoint = Number(body.reorderPoint);
  const reorderQty = Number(body.reorderQty);
  if (!Number.isFinite(reorderPoint) || reorderPoint < 0) {
    return NextResponse.json({ error: "reorderPoint must be a non-negative finite number" }, { status: 400 });
  }
  if (!Number.isFinite(reorderQty) || reorderQty <= 0) {
    return NextResponse.json({ error: "reorderQty must be a positive finite number" }, { status: 400 });
  }
  try {
    await upsertReorderRule(await resolvePurchasingActor(ctx), {
      itemId: body.itemId,
      locationId: body.locationId,
      reorderPoint,
      reorderQty,
      preferredSupplierId: typeof body.preferredSupplierId === "string" ? body.preferredSupplierId : null,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    const mapped = purchasingErrorResponse(e);
    if (mapped) return mapped;
    console.error("upsertReorderRule failed", { tenantId: ctx.tenantId, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
