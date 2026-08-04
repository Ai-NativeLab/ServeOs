import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { withTenant } from "@/db/with-tenant";
import { adjustStock } from "@/server/inventory/service";
import { DimensionalUomError, InventoryConfigError } from "@/server/inventory/errors";
import { webFingerprint } from "@/server/audit/fingerprint";

/**
 * The supported way to correct stock. Waste is a distinct ledger type rather
 * than a negative adjustment, so shrinkage stays reportable instead of being
 * indistinguishable from a recount.
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
  if (!body?.itemId || !body?.locationId || !body?.uom || typeof body?.baseQty !== "number") {
    return NextResponse.json({ error: "itemId, locationId, uom and numeric baseQty are required" }, { status: 400 });
  }
  if (body.type && body.type !== "adjustment" && body.type !== "waste") {
    return NextResponse.json({ error: "type must be 'adjustment' or 'waste'" }, { status: 400 });
  }
  try {
    await withTenant(ctx.tenantId, (tx) => adjustStock(tx, {
      tenantId: ctx.tenantId,
      itemId: body.itemId, locationId: body.locationId,
      baseQty: body.baseQty, uom: body.uom,
      type: body.type ?? "adjustment",
      lotId: body.lotId ?? null,
      byUserId: ctx.user.id,
      note: body.note ?? null,
      audit: { actorUserId: ctx.user.id, fingerprint: webFingerprint(req) },
    }));
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    if (e instanceof DimensionalUomError || e instanceof InventoryConfigError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
