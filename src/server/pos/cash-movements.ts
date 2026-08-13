import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { recordAuditEvent } from "@/server/audit/service";
import { getShiftPolicy } from "@/server/tenancy/settings";
import type { Permission } from "@/server/rbac/permissions";
import { and, eq, sql } from "drizzle-orm";
import { cashMovements, posShifts, type CashMovement, type CashMovementType } from "./shift-schema";
import { posSyncEventReceipts } from "./schema";
import { findSyncReceipt, reviveDates, type SyncReceipt } from "./sync-receipt";
import { CashMovementError, NoOpenShiftError } from "./errors";
import { resolveAuthorizer, resolveOfflineAuthorizer } from "./grants";
import { findOpenShift, shiftAuditCtx } from "./shifts";
import { round2 } from "./shift-math";
import type { PosCashierContext } from "./require-cashier";

export type { CashMovementType };

export type CashMovementInput = {
  type: CashMovementType;
  /** A positive magnitude — the service applies the sign for the type. */
  amount: number;
  reasonCode: string;
  reasonText?: string;
  grants?: { permission: Permission; token: string }[];
  /** The device-claimed time; defaults to now(). */
  occurredAt?: Date;
  syncReceipt?: SyncReceipt;
  /** Replay-only substitute for a live grant token on an over-threshold
   *  pay-out — see shifts.ts's CloseShiftInput.authorizedByUserId for the
   *  same shape and the same "honored only alongside syncReceipt" rule. */
  authorizedByUserId?: string;
};

/**
 * Cash entering or leaving the drawer outside a sale.
 *
 * The caller passes a magnitude and the service applies the sign, so the stored
 * value, the DB CHECK, and the expected-cash formula can never disagree about
 * direction: a pay-in adds, a pay-out or safe-drop subtracts, a no-sale is a
 * drawer opening that moves nothing.
 */
export async function recordCashMovement(
  ctx: PosCashierContext,
  input: CashMovementInput,
): Promise<CashMovement> {
  const magnitude = round2(input.amount);
  if (input.type === "no_sale") {
    if (magnitude !== 0) throw new CashMovementError("A no_sale records no cash");
  } else if (!(magnitude > 0)) {
    throw new CashMovementError("A movement amount must be a positive magnitude");
  }
  const signed = input.type === "pay_in" ? magnitude : input.type === "no_sale" ? 0 : -magnitude;

  // Cheap pre-check, mirroring closeShift's: a plain retry answers here
  // before the "no open shift" check below — which must not run at all for a
  // replay whose shift has since closed, or it throws NoOpenShiftError for a
  // movement that already applied. The authoritative recheck, inside the
  // advisory lock, is what actually closes the concurrent-replay race.
  if (input.syncReceipt) {
    const stored = await findSyncReceipt(input.syncReceipt);
    if (stored) return reviveDates(stored.resultJson as CashMovement, ["createdAt"]);
  }

  // Cheap pre-check so "there is no drawer" is reported before a manager's
  // single-use grant would be spent. The authoritative read is inside the
  // transaction below.
  if (!(await findOpenShift(ctx.tenantId, ctx.deviceId))) throw new NoOpenShiftError();

  // Routine pay-outs are the cashier's own call; a large one is a manager's.
  // resolveAuthorizer returns the cashier when they hold reconciliation:manage,
  // the grant's manager otherwise, and throws PosForbiddenError if neither. A
  // synced offline pay-out names its manager directly (input.authorizedByUserId)
  // instead of a live grant token — only trusted alongside syncReceipt, which
  // only the sync ingest dispatcher ever sets.
  const policy = await getShiftPolicy(ctx.tenantId);
  let authorizedByUserId: string | null = null;
  let authorizerDeactivated = false;
  if (input.type === "pay_out" && policy.payoutThreshold > 0 && magnitude > policy.payoutThreshold) {
    if (input.syncReceipt && input.authorizedByUserId) {
      const off = await resolveOfflineAuthorizer(ctx.tenantId, input.authorizedByUserId, "reconciliation:manage");
      authorizedByUserId = off.userId;
      authorizerDeactivated = off.deactivated;
    } else {
      const grant = input.grants?.find((g) => g.permission === "reconciliation:manage")?.token;
      authorizedByUserId = await resolveAuthorizer(ctx, "reconciliation:manage", grant);
    }
  }

  return withTenant(ctx.tenantId, async (tx) => {
    // A movement has no natural idempotency key (unlike a sale's clientOrderId
    // or a shift's clientShiftId) — the receipt is what gives it one. Locked
    // on the event itself, not the shift row below: that row only exists to
    // lock while the shift is open, so a replay arriving after the shift has
    // since closed would otherwise have nothing serializing this check against
    // a concurrent replay of the same event.
    if (input.syncReceipt) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.syncReceipt.eventId})::bigint)`);
      const stored = await findSyncReceipt(input.syncReceipt, tx);
      if (stored) return reviveDates(stored.resultJson as CashMovement, ["createdAt"]);
    }

    // Re-resolve the drawer on THIS transaction and lock the row. This is the
    // ONLY thing serializing a movement against a close or a mid-shift count —
    // neither of those takes it via this path, they take the same row with
    // FOR UPDATE before they read the drawer, so whichever of us gets the row
    // first, the other sees a settled drawer. A close mid-flight blocks us and
    // we then see 'closed' and refuse; a close starting after us waits for this
    // movement to commit and counts it.
    //
    // Do not weaken either side to an unlocked read: the close's advisory lock
    // is keyed on the shift and this path never takes it, so the row lock is
    // what actually holds the two apart.
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open")))
      .limit(1)
      .for("update");
    if (!shift) throw new NoOpenShiftError();

    const [row] = await tx
      .insert(cashMovements)
      .values({
        tenantId: ctx.tenantId,
        shiftId: shift.id,
        type: input.type,
        amount: money(signed),
        reasonCode: input.reasonCode,
        reasonText: input.reasonText ?? null,
        byUserId: ctx.cashierUserId,
        authorizedByUserId,
        createdAt: input.occurredAt ?? new Date(),
      })
      .returning();

    await recordAuditEvent(shiftAuditCtx(ctx), {
      action: "cash.movement",
      entityType: "cash_movement",
      entityId: row.id,
      summary: `${input.type} ${money(signed)}`,
      metadata: {
        shiftId: shift.id,
        type: input.type,
        amount: money(signed),
        reasonCode: input.reasonCode,
        authorizedByUserId,
        ...(authorizerDeactivated ? { authorizerDeactivated: true } : {}),
      },
      actorType: "user",
    }, tx);

    if (input.syncReceipt) {
      await tx.insert(posSyncEventReceipts).values({ ...input.syncReceipt, resultJson: row });
    }

    return row;
  });
}
