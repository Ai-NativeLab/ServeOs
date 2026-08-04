import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { withTenant } from "@/db/with-tenant";
import { transferStock } from "@/server/inventory/service";
import { DimensionalUomError, InventoryConfigError } from "@/server/inventory/errors";
import { webFingerprint } from "@/server/audit/fingerprint";

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:manage");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const body = await req.json();
  if (!body?.itemId || !body?.fromLocationId || !body?.toLocationId || !body?.uom || typeof body?.baseQty !== "number") {
    return NextResponse.json(
      { error: "itemId, fromLocationId, toLocationId, uom and numeric baseQty are required" }, { status: 400 },
    );
  }
  if (body.fromLocationId === body.toLocationId) {
    return NextResponse.json({ error: "source and destination must differ" }, { status: 400 });
  }
  try {
    // Both legs commit together, so stock is never in flight between locations.
    await withTenant(ctx.tenantId, (tx) => transferStock(tx, {
      tenantId: ctx.tenantId,
      itemId: body.itemId,
      fromLocationId: body.fromLocationId, toLocationId: body.toLocationId,
      baseQty: body.baseQty, uom: body.uom,
      byUserId: ctx.user.id, note: body.note ?? null,
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
