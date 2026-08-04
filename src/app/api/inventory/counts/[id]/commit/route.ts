import { NextRequest, NextResponse } from "next/server";
import { requireInventoryPermission } from "@/app/dashboard/inventory-permission";
import { UnauthorizedError } from "@/server/rbac/authorize";
import { withTenant } from "@/db/with-tenant";
import { commitCount } from "@/server/inventory/service";
import { InventoryConfigError } from "@/server/inventory/errors";
import { webFingerprint } from "@/server/audit/fingerprint";

/**
 * Commits a count: one `count` ledger row per discrepant line, in a single
 * transaction, then the count is closed. Committing twice is rejected rather
 * than silently writing the variance again.
 *
 * `params` is a promise and must be awaited in this Next version.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let ctx;
  try {
    ctx = await requireInventoryPermission("inventory:count");
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    throw e;
  }
  const { id } = await params;
  try {
    await withTenant(ctx.tenantId, (tx) => commitCount(tx, ctx.tenantId, id, ctx.user.id, {
      actorUserId: ctx.user.id, fingerprint: webFingerprint(req),
    }));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof InventoryConfigError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
