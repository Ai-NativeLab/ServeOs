import { NextRequest, NextResponse } from "next/server";
import { resolveInventoryContext } from "@/app/dashboard/inventory-permission";
import { getOnHand, listLots } from "@/server/inventory/read";

export async function GET(req: NextRequest) {
  const { ctx, denied } = await resolveInventoryContext("inventory:view");
  if (denied) return denied;
  const p = req.nextUrl.searchParams;
  const itemId = p.get("itemId") ?? undefined;
  const locationId = p.get("locationId") ?? undefined;
  const rows = await getOnHand(ctx.tenantId, { itemId, locationId });
  // The lot breakdown is only meaningful for a single item, so it is not
  // returned for a whole-tenant sweep.
  const lots = itemId ? await listLots(ctx.tenantId, { itemId, locationId }) : [];
  return NextResponse.json({ onHand: rows, lots });
}
