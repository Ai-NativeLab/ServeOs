import { NextResponse } from "next/server";
import { requireAuditPermission } from "@/app/dashboard/audit-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { getChainStatus } from "@/server/audit/read";

export async function GET() {
  let ctx;
  try {
    ctx = await requireAuditPermission();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e; // requireDashboardUser redirects unauthenticated users
  }
  return NextResponse.json(await getChainStatus(ctx.tenantId));
}
