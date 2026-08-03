import { NextRequest, NextResponse } from "next/server";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { listNotifications } from "@/server/notifications/service";
import type { NotificationSeverity, NotificationType } from "@/server/notifications/schema";

export async function GET(req: NextRequest) {
  const ctx = await requireDashboardUser();
  const p = req.nextUrl.searchParams;
  const result = await listNotifications(ctx.tenantId, ctx.user.id, ctx.roleKeys, {
    unread: p.get("unread") === "1",
    type: (p.get("type") as NotificationType) ?? undefined,
    severity: (p.get("severity") as NotificationSeverity) ?? undefined,
  });
  return NextResponse.json(result);
}
