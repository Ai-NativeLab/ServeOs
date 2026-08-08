import { NextRequest, NextResponse } from "next/server";
import { resolveInventoryContext } from "@/app/dashboard/inventory-permission";
import { withTenant } from "@/db/with-tenant";
import { listItems } from "@/server/inventory/read";
import { inventoryItems } from "@/server/inventory/schema";
import { assertInventoryUom } from "@/server/inventory/uom";
import { DimensionalUomError } from "@/server/inventory/errors";
import type { InventoryItem } from "@/server/inventory/schema";

export async function GET(req: NextRequest) {
  const { ctx, denied } = await resolveInventoryContext("inventory:view");
  if (denied) return denied;
  const p = req.nextUrl.searchParams;
  const items = await listItems(ctx.tenantId, {
    kind: (p.get("kind") as InventoryItem["kind"]) ?? undefined,
    isActive: p.get("isActive") ? p.get("isActive") === "true" : undefined,
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
  });
  return NextResponse.json(items);
}

export async function POST(req: NextRequest) {
  const { ctx, denied } = await resolveInventoryContext("inventory:manage");
  if (denied) return denied;
  const body = await req.json();
  if (!body?.nameEn || !body?.nameAr || !body?.kind || !body?.baseUom) {
    return NextResponse.json({ error: "nameEn, nameAr, kind and baseUom are required" }, { status: 400 });
  }
  try {
    // Every UoM is narrowed here: the DB enum is a superset that also carries
    // P4's sellable m/m2/bf, which are not stockable.
    const baseUom = assertInventoryUom(body.baseUom);
    const [item] = await withTenant(ctx.tenantId, (tx) => tx.insert(inventoryItems).values({
      tenantId: ctx.tenantId,
      nameEn: body.nameEn, nameAr: body.nameAr, sku: body.sku ?? null,
      kind: body.kind,
      baseUom,
      stockUom: assertInventoryUom(body.stockUom ?? body.baseUom),
      stockToBase: body.stockToBase ?? "1",
      purchaseUom: assertInventoryUom(body.purchaseUom ?? body.baseUom),
      purchaseToBase: body.purchaseToBase ?? "1",
      recipeUom: assertInventoryUom(body.recipeUom ?? body.baseUom),
      recipeToBase: body.recipeToBase ?? "1",
      isPerishable: body.isPerishable ?? false,
      defaultUnitCost: body.defaultUnitCost ?? null,
    }).returning());
    return NextResponse.json(item, { status: 201 });
  } catch (e) {
    if (e instanceof DimensionalUomError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
