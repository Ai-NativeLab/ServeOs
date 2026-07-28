import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { recordAuditEvent, type AuditContext } from "@/server/audit/service";
import { posShifts, cashCounts, type PosShift } from "./shift-schema";
import { CashCountMismatchError, ShiftAlreadyOpenError } from "./errors";
import { round2, sumDenominations } from "./shift-math";
import type { PosCashierContext } from "./require-cashier";

export type OpenShiftInput = {
  openingFloat: number;
  denominations?: Record<string, number>;
};

/** One AuditContext shape for every shift-domain emission (open, close, movements, counts). */
export function shiftAuditCtx(ctx: PosCashierContext): AuditContext {
  return {
    tenantId: ctx.tenantId,
    branchId: ctx.branchId,
    actorUserId: ctx.cashierUserId,
    fingerprint: ctx.fingerprint,
  };
}

/**
 * Starts a cashier's session at one drawer.
 *
 * One open shift per device is an invariant, held twice: the advisory lock
 * serializes concurrent opens on the same drawer (the lock discipline
 * `placeOrder` uses for order numbers, keyed on the device instead of the
 * tenant), and the unique partial index `(device_id) WHERE status = 'open'`
 * catches anything that bypasses this function.
 */
export async function openShift(ctx: PosCashierContext, input: OpenShiftInput): Promise<PosShift> {
  // Guard the count before opening a transaction — a float that disagrees with
  // the notes in the drawer is a counting error, not a shift.
  if (input.denominations && sumDenominations(input.denominations) !== round2(input.openingFloat)) {
    throw new CashCountMismatchError();
  }

  return withTenant(ctx.tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.deviceId})::bigint)`);

    const [alreadyOpen] = await tx
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open")))
      .limit(1);
    if (alreadyOpen) throw new ShiftAlreadyOpenError();

    const openingFloat = money(input.openingFloat);
    const [shift] = await tx
      .insert(posShifts)
      .values({
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deviceId: ctx.deviceId,
        openedByUserId: ctx.cashierUserId,
        status: "open",
        openingFloat,
      })
      .returning();

    // The opening count is the float: counted is expected, variance is zero.
    const [count] = await tx
      .insert(cashCounts)
      .values({
        tenantId: ctx.tenantId,
        shiftId: shift.id,
        kind: "opening",
        countedTotal: openingFloat,
        expectedTotal: openingFloat,
        variance: money(0),
        denominations: input.denominations ?? null,
        byUserId: ctx.cashierUserId,
      })
      .returning();

    await recordAuditEvent(shiftAuditCtx(ctx), {
      action: "shift.open",
      entityType: "pos_shift",
      entityId: shift.id,
      summary: `Shift opened (float ${openingFloat})`,
      metadata: { deviceId: ctx.deviceId, openingFloat, countId: count.id },
      actorType: "user",
    }, tx);

    return shift;
  });
}

/** The drawer's current session, or null. Every tender stamp and movement starts here. */
export async function findOpenShift(tenantId: string, deviceId: string): Promise<PosShift | null> {
  const [shift] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(posShifts)
      .where(and(eq(posShifts.deviceId, deviceId), eq(posShifts.status, "open")))
      .limit(1),
  );
  return shift ?? null;
}
