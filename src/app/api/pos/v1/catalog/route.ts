import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { PosAuthError } from "@/server/pos/errors";
import { getPublishedMenu } from "@/server/catalog/service";
import { getCheckoutPricing } from "@/server/tenancy/settings";

export async function GET(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }
  const [menu, pricing] = await Promise.all([
    getPublishedMenu(device.tenantId, device.branchId),
    getCheckoutPricing(device.tenantId),
  ]);
  return NextResponse.json({ menu, pricing, syncedAt: new Date().toISOString() });
}
