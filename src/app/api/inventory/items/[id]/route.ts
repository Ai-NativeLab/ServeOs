import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { resolveInventoryContext } from "@/app/dashboard/inventory-permission";
import { withTenant } from "@/db/with-tenant";
import { inventoryItems } from "@/server/inventory/schema";
import { assertInventoryUom } from "@/server/inventory/uom";
import { DimensionalUomError, InventoryConfigError } from "@/server/inventory/errors";

/**
 * Edits an item's descriptive fields, conversion factors and active flag.
 *
 * `baseUom` is deliberately NOT editable: every ledger row and lot quantity is
 * already stored normalized to it, so changing it would silently reinterpret
 * history — 500 g becoming 500 kg. Correcting a mis-set base unit means a new
 * item and a transfer, which leaves an auditable trail.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolveInventoryContext("inventory:manage");
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json();

  if (body?.baseUom !== undefined) {
    return NextResponse.json(
      { error: "baseUom cannot be changed — existing ledger rows are stored in it. Create a new item instead." },
      { status: 400 },
    );
  }

  try {
    const patch: Partial<typeof inventoryItems.$inferInsert> = {};
    if (body?.nameEn !== undefined) patch.nameEn = body.nameEn;
    if (body?.nameAr !== undefined) patch.nameAr = body.nameAr;
    if (body?.sku !== undefined) patch.sku = body.sku;
    if (body?.kind !== undefined) patch.kind = body.kind;
    if (body?.isPerishable !== undefined) patch.isPerishable = body.isPerishable;
    if (body?.isActive !== undefined) patch.isActive = body.isActive;
    if (body?.defaultUnitCost !== undefined) patch.defaultUnitCost = body.defaultUnitCost;
    // Each unit is narrowed before it can reach the row — the shared enum is a
    // superset that also carries P4's sellable m/m2/bf.
    if (body?.stockUom !== undefined) patch.stockUom = assertInventoryUom(body.stockUom);
    if (body?.purchaseUom !== undefined) patch.purchaseUom = assertInventoryUom(body.purchaseUom);
    if (body?.recipeUom !== undefined) patch.recipeUom = assertInventoryUom(body.recipeUom);
    if (body?.stockToBase !== undefined) patch.stockToBase = body.stockToBase;
    if (body?.purchaseToBase !== undefined) patch.purchaseToBase = body.purchaseToBase;
    if (body?.recipeToBase !== undefined) patch.recipeToBase = body.recipeToBase;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
    }

    const [updated] = await withTenant(ctx.tenantId, (tx) => tx.update(inventoryItems)
      .set(patch).where(eq(inventoryItems.id, id)).returning());
    if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(updated);
  } catch (e) {
    if (e instanceof DimensionalUomError || e instanceof InventoryConfigError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
