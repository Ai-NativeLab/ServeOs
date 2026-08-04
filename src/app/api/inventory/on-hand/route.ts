import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { getOnHand, listLots } from "@/server/inventory/read";

export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:view");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const p = req.nextUrl.searchParams;
  const itemId = p.get("itemId") ?? undefined;
  const locationId = p.get("locationId") ?? undefined;
  const rows = await getOnHand(ctx.tenantId, { itemId, locationId });
  // The lot breakdown is only meaningful for a single item, so it is not
  // returned for a whole-tenant sweep.
  const lots = itemId ? await listLots(ctx.tenantId, { itemId, locationId }) : [];
  return NextResponse.json({ onHand: rows, lots });
}
