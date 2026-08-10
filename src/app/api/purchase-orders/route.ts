import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { createDraftPo, listPurchaseOrders } from "@/server/purchasing/service";

function parseLines(raw: unknown): Parameters<typeof createDraftPo>[1]["lines"] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "lines must be a non-empty array" };
  }
  const lines: Parameters<typeof createDraftPo>[1]["lines"] = [];
  for (const l of raw) {
    const row = (l ?? {}) as Record<string, unknown>;
    if (typeof row.itemId !== "string" || !row.itemId) return { error: "each line needs a string itemId" };
    const qtyOrdered = Number(row.qtyOrdered);
    const unitCost = Number(row.unitCost);
    if (!Number.isFinite(qtyOrdered) || qtyOrdered <= 0) return { error: "each line needs a positive qtyOrdered" };
    if (!Number.isFinite(unitCost) || unitCost < 0) return { error: "each line needs a non-negative unitCost" };
    if (typeof row.uom !== "string" || !row.uom) return { error: "each line needs a uom" };
    lines.push({
      itemId: row.itemId,
      qtyOrdered,
      uom: row.uom as never,
      unitCost,
      taxRate: row.taxRate !== undefined ? Number(row.taxRate) : undefined,
    });
  }
  return lines;
}

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
    console.error("createDraftPo failed", { tenantId: ctx.tenantId, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
