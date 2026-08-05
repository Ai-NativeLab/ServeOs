import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { CapabilityNotEnabledError } from "@/server/verticals/errors";
import { listRecipes, createRecipe } from "@/server/inventory/recipes";
import { DimensionalUomError, InventoryConfigError } from "@/server/inventory/errors";
import { webFingerprint } from "@/server/audit/fingerprint";

export async function GET() {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  return NextResponse.json(await listRecipes(ctx.tenantId));
}

/** Creates a bill of materials, optionally with its components in one call. */
export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:manage");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const body = await req.json();
  if (!body?.nameEn || !body?.nameAr) {
    return NextResponse.json({ error: "nameEn and nameAr are required" }, { status: 400 });
  }
  try {
    const recipe = await createRecipe(ctx.tenantId, {
      nameEn: body.nameEn, nameAr: body.nameAr,
      yieldQty: body.yieldQty, yieldUom: body.yieldUom,
      components: body.components,
    }, { actorUserId: ctx.user.id, fingerprint: webFingerprint(req) });
    return NextResponse.json(recipe, { status: 201 });
  } catch (e) {
    // A vertical without the `recipes` capability asking for one is a 409, not a
    // validation error — the request is well-formed, the tenant just isn't a kitchen.
    if (e instanceof CapabilityNotEnabledError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof DimensionalUomError || e instanceof InventoryConfigError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
