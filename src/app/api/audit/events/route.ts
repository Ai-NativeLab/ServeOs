import { NextRequest, NextResponse } from "next/server";
import { requireAuditPermission } from "@/app/dashboard/audit-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { listAuditEvents } from "@/server/audit/read";

export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requireAuditPermission();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e; // requireDashboardUser redirects unauthenticated users
  }
  const p = req.nextUrl.searchParams;
  const events = await listAuditEvents(ctx.tenantId, {
    action: p.get("action") ?? undefined,
    entityType: p.get("entityType") ?? undefined,
    entityId: p.get("entityId") ?? undefined,
    actorUserId: p.get("actorUserId") ?? undefined,
    actorType: p.get("actorType") ?? undefined,
    from: p.get("from") ? new Date(p.get("from")!) : undefined,
    to: p.get("to") ? new Date(p.get("to")!) : undefined,
    limit: p.get("limit") ? Number(p.get("limit")) : undefined,
  });
  return NextResponse.json(events);
}
