import { NextRequest, NextResponse } from "next/server";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { markNotificationsRead } from "@/server/notifications/service";

export async function POST(req: NextRequest) {
  const ctx = await requireDashboardUser();
  const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
  await markNotificationsRead(ctx.tenantId, ctx.user.id, ctx.roleKeys, body.ids);
  return NextResponse.json({ ok: true });
}
