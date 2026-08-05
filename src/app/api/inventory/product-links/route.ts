import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { CapabilityNotEnabledError } from "@/server/verticals/errors";
import { listProductLinks, linkProduct, unlinkProduct } from "@/server/inventory/recipes";
import { InventoryConfigError } from "@/server/inventory/errors";
import { webFingerprint } from "@/server/audit/fingerprint";

export async function GET() {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  return NextResponse.json(await listProductLinks(ctx.tenantId));
}

/**
 * Points a sellable at what it consumes — a recipe, or a finished-goods item.
 * This is the row `placeOrder` resolves; without it a product sells without
 * touching stock at all.
 */
export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:manage");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const body = await req.json();
  if (!body?.productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  if (body.linkType !== "recipe" && body.linkType !== "finished_good") {
    return NextResponse.json({ error: "linkType must be 'recipe' or 'finished_good'" }, { status: 400 });
  }
  if (body.linkType === "recipe" && !body.recipeId) {
    return NextResponse.json({ error: "recipeId is required for a recipe link" }, { status: 400 });
  }
  if (body.linkType === "finished_good" && !body.itemId) {
    return NextResponse.json({ error: "itemId is required for a finished_good link" }, { status: 400 });
  }

  try {
    const link = await linkProduct(ctx.tenantId, body.linkType === "recipe"
      ? { productId: body.productId, variantId: body.variantId ?? null, linkType: "recipe", recipeId: body.recipeId }
      : { productId: body.productId, variantId: body.variantId ?? null, linkType: "finished_good", itemId: body.itemId },
      { actorUserId: ctx.user.id, fingerprint: webFingerprint(req) });
    return NextResponse.json(link, { status: 201 });
  } catch (e) {
    if (e instanceof CapabilityNotEnabledError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof InventoryConfigError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:manage");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const p = req.nextUrl.searchParams;
  const productId = p.get("productId");
  if (!productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });

  try {
    await unlinkProduct(ctx.tenantId, productId, p.get("variantId"),
      { actorUserId: ctx.user.id, fingerprint: webFingerprint(req) });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CapabilityNotEnabledError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof InventoryConfigError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
