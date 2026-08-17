import { NextRequest, NextResponse } from "next/server";
import { resolvePurchasingContext, resolvePurchasingActor } from "@/app/dashboard/purchasing-permission";
import { listSupplierItems, upsertSupplierItem } from "@/server/purchasing/suppliers";
import { INVENTORY_UOMS, type Uom } from "@/server/inventory/uom";
import { purchasingErrorResponse } from "../../../purchasing-errors";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("suppliers:manage");
  if (denied) return denied;
  const { id } = await params;
  const rows = await listSupplierItems(ctx.tenantId, id);
  return NextResponse.json({ items: rows });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolvePurchasingContext("suppliers:manage");
  if (denied) return denied;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.itemId !== "string" || !body.itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }
  if (body.lastUnitCost !== undefined && (typeof body.lastUnitCost !== "number" || !Number.isFinite(body.lastUnitCost))) {
    return NextResponse.json({ error: "lastUnitCost must be a finite number" }, { status: 400 });
  }
  let packUom: Uom | undefined;
  if (body.packUom !== undefined) {
    if (typeof body.packUom !== "string" || !INVENTORY_UOMS.includes(body.packUom as Uom)) {
      return NextResponse.json({ error: `packUom must be one of ${INVENTORY_UOMS.join(", ")}` }, { status: 400 });
    }
    packUom = body.packUom as Uom;
  }
  try {
    await upsertSupplierItem(await resolvePurchasingActor(ctx), {
      supplierId: id,
      itemId: body.itemId,
      supplierSku: typeof body.supplierSku === "string" ? body.supplierSku : undefined,
      lastUnitCost: body.lastUnitCost !== undefined ? Number(body.lastUnitCost) : undefined,
      packUom,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    const mapped = purchasingErrorResponse(e);
    if (mapped) return mapped;
    console.error("upsertSupplierItem failed", { tenantId: ctx.tenantId, supplierId: id, error: e });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
