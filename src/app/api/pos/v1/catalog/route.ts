import { NextRequest, NextResponse } from "next/server";
import { requirePosDevice } from "@/server/pos/require-device";
import { PosAuthError } from "@/server/pos/errors";
import { getPublishedMenu } from "@/server/catalog/service";

export async function GET(req: NextRequest) {
  let device;
  try {
    device = await requirePosDevice(req);
  } catch (e) {
    if (e instanceof PosAuthError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    throw e;
  }
  const menu = await getPublishedMenu(device.tenantId, device.branchId);
  return NextResponse.json({ menu, syncedAt: new Date().toISOString() });
}
