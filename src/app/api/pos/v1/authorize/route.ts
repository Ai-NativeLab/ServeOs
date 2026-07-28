import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { verifyAuthorizer } from "@/server/pos/cashier";
import { issueGrant } from "@/server/pos/grants";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";
import { PERMISSIONS, type Permission } from "@/server/rbac/permissions";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent } from "@/server/audit/service";

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await requirePosCashier(req);
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  const { email, password, permission } = (await req.json()) as {
    email?: string; password?: string; permission?: string;
  };
  if (!email || !password || !permission) {
    return NextResponse.json({ error: "Missing email, password, or permission" }, { status: 400 });
  }
  // Only counter permissions are grantable at the till: the `pos:*` family plus
  // reconciliation:manage (cross-cashier close, over-threshold pay-out).
  const grantable = permission.startsWith("pos:") || permission === "reconciliation:manage";
  if (!PERMISSIONS.includes(permission as Permission) || !grantable) {
    return NextResponse.json({ error: "Unknown permission" }, { status: 400 });
  }

  try {
    const manager = await verifyAuthorizer(ctx.tenantId, email, password, permission as Permission);
    const grant = issueGrant(ctx.tenantId, permission as Permission, manager.userId);
    // The grant itself lives in memory; the durable record that a manager
    // authorized an over-permission for this cashier is the audit row.
    await withTenant(ctx.tenantId, (tx) => recordAuditEvent(
      { tenantId: ctx.tenantId, branchId: ctx.branchId, actorUserId: manager.userId, fingerprint: ctx.fingerprint },
      { action: "authz.manager_granted", entityType: "authorization", entityId: permission,
        summary: `${manager.name} authorized ${permission} for ${ctx.cashierName}`,
        metadata: { permission, cashierUserId: ctx.cashierUserId }, actorType: "user" },
      tx,
    ));
    return NextResponse.json({ grant, authorizedBy: manager.name });
  } catch (e) {
    if (e instanceof PosCashierError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
