import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { createDraftPo, listPurchaseOrders } from "@/server/purchasing/service";
import { purchasingErrorResponse } from "../purchasing-errors";
import { parseLines } from "./validation";

export async function GET(req: NextRequest) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const rows = await listPurchaseOrders(ctx.tenantId, { status: status as never });
  return NextResponse.json({ purchaseOrders: rows });
}

export async function POST(req: NextRequest) {
  const { ctx, denied } = await resolvePurchasingContext("purchasing:manage");
  if (denied) return denied;
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
  const lines = parseLines(body.lines);
  if ("error" in lines) return NextResponse.json({ error: lines.error }, { status: 400 });
  try {
    const actor = await resolvePurchasingActor(ctx);
    const { poId, poNumber } = await createDraftPo(actor, {
      supplierId: body.supplierId,
      branchId: body.branchId,
      expectedAt: typeof body.expectedAt === "string" ? new Date(body.expectedAt) : null,
      lines,
    });
    return NextResponse.json({ poId, poNumber }, { status: 201 });
  } catch (e) {
    const mapped = purchasingErrorResponse(e);
    if (mapped) return mapped;
    console.error("createDraftPo failed", { tenantId: ctx.tenantId, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
