import { NextRequest, NextResponse } from "next/server";
import { resolveInventoryContext } from "@/app/dashboard/inventory-permission";
import { CapabilityNotEnabledError } from "@/server/verticals/errors";
import { getRecipe, updateRecipe, setRecipeComponents } from "@/server/inventory/recipes";
import { DimensionalUomError, InventoryConfigError } from "@/server/inventory/errors";
import { webFingerprint } from "@/server/audit/fingerprint";

function toStatus(e: unknown): NextResponse | null {
  if (e instanceof CapabilityNotEnabledError) return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof DimensionalUomError || e instanceof InventoryConfigError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolveInventoryContext("inventory:view");
  if (denied) return denied;
  const { id } = await params;
  const recipe = await getRecipe(ctx.tenantId, id);
  if (!recipe) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(recipe);
}

/**
 * Edits the recipe header and, when `components` is present, replaces the whole
 * component list. A bill of materials is edited as a unit, so replace-all keeps
 * callers from having to diff.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { ctx, denied } = await resolveInventoryContext("inventory:manage");
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json();
  const audit = { actorUserId: ctx.user.id, fingerprint: webFingerprint(req) };

  try {
    const header = ["nameEn", "nameAr", "yieldQty", "yieldUom", "isActive"].some((k) => body?.[k] !== undefined);
    if (header) {
      await updateRecipe(ctx.tenantId, id, {
        nameEn: body.nameEn, nameAr: body.nameAr,
        yieldQty: body.yieldQty, yieldUom: body.yieldUom, isActive: body.isActive,
      }, audit);
    }
    if (Array.isArray(body?.components)) {
      await setRecipeComponents(ctx.tenantId, id, body.components, audit);
    }
    if (!header && !Array.isArray(body?.components)) {
      return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
    }
    return NextResponse.json(await getRecipe(ctx.tenantId, id));
  } catch (e) {
    const mapped = toStatus(e);
    if (mapped) return mapped;
    throw e;
  }
}
