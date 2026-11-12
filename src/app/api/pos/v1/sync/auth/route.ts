import { NextRequest, NextResponse } from "next/server";
import { requirePosCashier } from "@/server/pos/require-cashier";
import { PosAuthError, PosCashierError } from "@/server/pos/errors";
import { listPosUsers } from "@/server/pos/auth-sync";
import { recordRosterSynced } from "@/server/audit/read-events";

/**
 * Sync-down of the tenant's POS auth roster (Task 10 wires the client cadence:
 * pulled after every successful online cashier sign-in and on the periodic
 * online timer). requirePosCashier, deliberately NOT requirePosDevice alone —
 * this hands out scrypt hashes for every POS-capable user of the branch, so it
 * must be gated behind a signed-in human, per the offline-sync design spec's
 * accepted-risk threat model.
 */
export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requirePosCashier(req);
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    throw e;
  }

  const users = await listPosUsers(ctx.tenantId);
  // Never logs the roster itself — only that it was pulled, by whom, to which device.
  await recordRosterSynced(ctx.tenantId, users.map((u) => u.userId), {
    actorUserId: ctx.cashierUserId, fingerprint: ctx.fingerprint,
  });

  return NextResponse.json({ users, syncedAt: new Date().toISOString() });
}
