import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { verifyAuthorizer } from "@/server/pos/cashier";
import { issueGrant } from "@/server/pos/grants";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";
import { PERMISSIONS, type Permission } from "@/server/rbac/permissions";

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
  if (!PERMISSIONS.includes(permission as Permission) || !permission.startsWith("pos:")) {
    return NextResponse.json({ error: "Unknown permission" }, { status: 400 });
  }

  try {
    const manager = await verifyAuthorizer(ctx.tenantId, email, password, permission as Permission);
    const grant = issueGrant(ctx.tenantId, permission as Permission, manager.userId);
    return NextResponse.json({ grant, authorizedBy: manager.name });
  } catch (e) {
    if (e instanceof PosCashierError) return NextResponse.json({ error: e.message }, { status: 401 });
    throw e;
  }
}
