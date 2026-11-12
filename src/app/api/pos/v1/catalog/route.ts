import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { posAuthResponse } from "@/server/pos/errors";
import { getPublishedMenu } from "@/server/catalog/service";
import { getCatalogVersion } from "@/server/catalog/version";
import { getCheckoutPricing, getShiftPolicy } from "@/server/tenancy/settings";
import { isFiscalEnabled } from "@/server/fiscal/enqueue";

export async function GET(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    const authRes = posAuthResponse(e);
    if (authRes) return authRes;
    throw e;
  }
  // shiftPolicy rides along with catalog/pricing because the sync engine
  // already pulls this endpoint on reconnect and on the periodic online tick
  // (Task 10) — it's the till's only way to learn payoutThreshold/blindClose,
  // which otherwise leaves cash-movement gating stuck on the offline-safe
  // "always ask for a manager" default (see pos-main.ts's cashMovement).
  //
  // fiscalEnabled rides along for the same reason: it is the till's only way to
  // know whether this tenant files with ETA (country EG AND activation
  // `active` — the exact gate the sale path enqueues on), which decides whether
  // the payment screen offers the business-buyer section at all. Cached by the
  // till so it survives an outage.
  const [menu, pricing, catalogVersion, shiftPolicy, fiscalEnabled] = await Promise.all([
    getPublishedMenu(device.tenantId, device.branchId),
    getCheckoutPricing(device.tenantId),
    getCatalogVersion(device.tenantId),
    getShiftPolicy(device.tenantId),
    isFiscalEnabled(device.tenantId),
  ]);
  return NextResponse.json({
    menu, pricing, catalogVersion, shiftPolicy, fiscalEnabled, syncedAt: new Date().toISOString(),
  });
}
