import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { PosAuthError } from "@/server/pos/errors";
import { getPublishedMenu } from "@/server/catalog/service";
import { getCatalogVersion } from "@/server/catalog/version";
import { getCheckoutPricing, getShiftPolicy } from "@/server/tenancy/settings";

export async function GET(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }
  // shiftPolicy rides along with catalog/pricing because the sync engine
  // already pulls this endpoint on reconnect and on the periodic online tick
  // (Task 10) — it's the till's only way to learn payoutThreshold/blindClose,
  // which otherwise leaves cash-movement gating stuck on the offline-safe
  // "always ask for a manager" default (see pos-main.ts's cashMovement).
  const [menu, pricing, catalogVersion, shiftPolicy] = await Promise.all([
    getPublishedMenu(device.tenantId, device.branchId),
    getCheckoutPricing(device.tenantId),
    getCatalogVersion(device.tenantId),
    getShiftPolicy(device.tenantId),
  ]);
  return NextResponse.json({ menu, pricing, catalogVersion, shiftPolicy, syncedAt: new Date().toISOString() });
}
