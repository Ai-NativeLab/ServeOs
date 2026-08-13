import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { money } from "@/server/ordering/service";
import { recordAuditEvent, type AuditContext } from "@/server/audit/service";
import { getShiftPolicy } from "@/server/tenancy/settings";
import type { Permission } from "@/server/rbac/permissions";
import {
  posShifts, cashCounts, cashMovements,
  type PosShift, type CashCount, type CashMovementType,
} from "./shift-schema";
import { orderPayments, posAdjustmentEvents, type OrderPayment } from "./tender-schema";
import { resolveAuthorizer } from "./grants";
import {
  CashCountMismatchError, NoOpenShiftError, ShiftAlreadyOpenError, ShiftClosedError,
} from "./errors";
import {
  computeExpectedCash, computeVariance, isVarianceFlagged, round2, sumDenominations,
} from "./shift-math";
import type { PosCashierContext } from "./require-cashier";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type OpenShiftInput = {
  openingFloat: number;
  denominations?: Record<string, number>;
};

export type CloseShiftInput = {
  count: { countedTotal: number; denominations?: Record<string, number> };
  grants?: { permission: Permission; token: string }[];
};

export type TenderTotal = { method: OrderPayment["method"]; amount: number; tips: number; count: number };
export type MovementTotal = { type: CashMovementType; total: number; count: number };

/** What both reports say about the shift, independent of whether it has been counted. */
export type ShiftReportCore = {
  shiftId: string;
  deviceId: string;
  branchId: string;
  openedByUserId: string;
  openedAt: string;
  openingFloat: number;
  tenders: TenderTotal[];
  salesCount: number;
  discountTotal: number;
  voidTotal: number;
  /** Zero until Spec 3 lands refunds. */
  refundTotal: number;
  movements: MovementTotal[];
};

/** Mid-shift snapshot. Reading it changes nothing. */
export type XReport = ShiftReportCore & {
  kind: "x";
  cash: { expected: number };
};

/** The close. `expected`/`variance` are null when blind close withholds them. */
export type ZReport = ShiftReportCore & {
  kind: "z";
  closedByUserId: string;
  closedAt: string;
  cash: { expected: number | null; counted: number; variance: number | null };
  flagged: boolean;
  approvedByUserId: string | null;
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

/**
 * Everything both reports are built from, gathered once: the shift's tenders,
 * its drawer movements, the adjustments on its orders, and the expected cash
 * those imply. Read-only — it is what makes the X-report non-resetting.
 */
async function gatherShift(tx: Tx, shift: PosShift): Promise<{ core: ShiftReportCore; expected: number }> {
  const tenders = await tx.select().from(orderPayments).where(eq(orderPayments.shiftId, shift.id));
  const movements = await tx.select().from(cashMovements).where(eq(cashMovements.shiftId, shift.id));
  const orderIds = [...new Set(tenders.map((t) => t.orderId))];
  const adjustments = orderIds.length
    ? await tx.select().from(posAdjustmentEvents).where(inArray(posAdjustmentEvents.orderId, orderIds))
    : [];

  const byMethod = new Map<OrderPayment["method"], TenderTotal>();
  for (const t of tenders) {
    const row = byMethod.get(t.method) ?? { method: t.method, amount: 0, tips: 0, count: 0 };
    row.amount = round2(row.amount + Number(t.amount));
    row.tips = round2(row.tips + Number(t.tipAmount));
    row.count += 1;
    byMethod.set(t.method, row);
  }

  // Movements are reported with the sign they were stored with; the formula
  // below takes magnitudes and decides direction itself.
  const byType = new Map<CashMovementType, MovementTotal>();
  for (const m of movements) {
    const row = byType.get(m.type) ?? { type: m.type, total: 0, count: 0 };
    row.total = round2(row.total + Number(m.amount));
    row.count += 1;
    byType.set(m.type, row);
  }
  const magnitude = (type: CashMovementType) =>
    round2(movements.filter((m) => m.type === type).reduce((s, m) => s + Math.abs(Number(m.amount)), 0));

  const expected = computeExpectedCash({
    openingFloat: Number(shift.openingFloat),
    cashTenders: byMethod.get("cash")?.amount ?? 0,
    cashRefunds: 0,
    payIns: magnitude("pay_in"),
    payOuts: magnitude("pay_out"),
    safeDrops: magnitude("safe_drop"),
  });

  const isDiscount = (type: string) => type === "line_discount" || type === "order_discount";
  const sumAdjustments = (want: boolean) =>
    round2(adjustments.filter((a) => isDiscount(a.type) === want).reduce((s, a) => s + Number(a.amount), 0));

  return {
    core: {
      shiftId: shift.id,
      deviceId: shift.deviceId,
      branchId: shift.branchId,
      openedByUserId: shift.openedByUserId,
      openedAt: shift.openedAt.toISOString(),
      openingFloat: Number(shift.openingFloat),
      tenders: [...byMethod.values()],
      salesCount: orderIds.length,
      discountTotal: sumAdjustments(true),
      voidTotal: sumAdjustments(false),
      refundTotal: 0,
      movements: [...byType.values()],
    },
    expected,
  };
}

/**
 * The mid-shift view. Computes the same expected cash the close will, records
 * no count, and never touches the shift — reading it twice is identical.
 */
export async function buildXReport(tenantId: string, shift: PosShift): Promise<XReport> {
  return withTenant(tenantId, async (tx) => {
    const { core, expected } = await gatherShift(tx, shift);
    return { kind: "x", ...core, cash: { expected } };
  });
}

/**
 * A count taken without closing — the drawer is verified mid-shift and keeps
 * trading. Same expected cash as the close would use; the shift is untouched.
 */
export async function recordMidShiftCount(
  ctx: PosCashierContext,
  shiftId: string,
  count: { countedTotal: number; denominations?: Record<string, number> },
): Promise<CashCount> {
  if (count.denominations && sumDenominations(count.denominations) !== round2(count.countedTotal)) {
    throw new CashCountMismatchError();
  }

  return withTenant(ctx.tenantId, async (tx) => {
    // Same drawer lock as the close, so a count either lands before the close
    // or sees the closed drawer — never straddles it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${shiftId})::bigint)`);

    // FOR UPDATE for the same reason the close takes it: the advisory lock does
    // not hold off recordCashMovement, so without the row a movement can commit
    // between this read and the count we persist below.
    const [shift] = await tx.select().from(posShifts).where(eq(posShifts.id, shiftId)).limit(1).for("update");
    if (!shift) throw new NoOpenShiftError();
    if (shift.status === "closed") throw new ShiftClosedError();

    const { expected } = await gatherShift(tx, shift);
    const counted = round2(count.countedTotal);
    const variance = computeVariance(counted, expected);

    const [row] = await tx
      .insert(cashCounts)
      .values({
        tenantId: ctx.tenantId,
        shiftId,
        kind: "mid_shift",
        countedTotal: money(counted),
        expectedTotal: money(expected),
        variance: money(variance),
        denominations: count.denominations ?? null,
        byUserId: ctx.cashierUserId,
      })
      .returning();

    await recordAuditEvent(shiftAuditCtx(ctx), {
      action: "count",
      entityType: "cash_count",
      entityId: row.id,
      summary: `Mid-shift count (variance ${money(variance)})`,
      metadata: {
        shiftId,
        expected: money(expected),
        counted: money(counted),
        variance: money(variance),
      },
      actorType: "user",
    }, tx);

    return row;
  });
}

/**
 * Counts the drawer and closes it.
 *
 * `expected` comes from the one formula; `variance = counted − expected` is
 * always persisted, even under blind close — that policy governs what the
 * cashier is shown, not what the business records. Closing someone else's
 * drawer, and settling a flagged variance, are manager actions.
 */
export async function closeShift(
  ctx: PosCashierContext,
  shiftId: string,
  input: CloseShiftInput,
): Promise<ZReport> {
  const policy = await getShiftPolicy(ctx.tenantId);
  if (input.count.denominations &&
      sumDenominations(input.count.denominations) !== round2(input.count.countedTotal)) {
    throw new CashCountMismatchError();
  }

  const grantToken = input.grants?.find((g) => g.permission === "reconciliation:manage")?.token;
  const holdsPermission = ctx.permissions.includes("reconciliation:manage");
  // Grants are single-use, so resolve at most once and reuse the answer: a close
  // that is BOTH cross-user and flagged must not spend the token twice.
  let authorizer: string | null = null;
  const authorize = async (): Promise<string> => {
    if (authorizer === null) authorizer = await resolveAuthorizer(ctx, "reconciliation:manage", grantToken);
    return authorizer;
  };
  // A grant is a manager standing at the till: validate it up front so one token
  // governs the cross-user close, the variance approval, and the blind reveal.
  if (!holdsPermission && grantToken) await authorize();
  const canManage = holdsPermission || authorizer !== null;

  return withTenant(ctx.tenantId, async (tx) => {
    // Serialize closes of this drawer, the way openShift serializes opens —
    // keyed on the shift because a close may name any shift, not just the one
    // open on this device.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${shiftId})::bigint)`);

    // FOR UPDATE, and before gatherShift: the advisory lock only serializes us
    // against other closes and counts. recordCashMovement never takes it — it
    // takes this row lock — so without holding the row from here, a movement can
    // commit between the read below and the UPDATE further down, and the count
    // we persist would omit cash that is really in the drawer.
    const [shift] = await tx.select().from(posShifts).where(eq(posShifts.id, shiftId)).limit(1).for("update");
    if (!shift) throw new NoOpenShiftError();
    if (shift.status === "closed") throw new ShiftClosedError();

    // Throws PosForbiddenError unless the permission is held or granted.
    if (shift.openedByUserId !== ctx.cashierUserId) await authorize();

    const { core, expected } = await gatherShift(tx, shift);
    const counted = round2(input.count.countedTotal);
    const variance = computeVariance(counted, expected);
    const flagged = isVarianceFlagged(variance, policy.varianceThreshold);
    // Who settled the discrepancy. Durable reconciliation state is Spec 7; this
    // is the approval as recorded on the count and in the audit chain.
    const approvedByUserId = flagged && canManage ? await authorize() : null;

    const [count] = await tx
      .insert(cashCounts)
      .values({
        tenantId: ctx.tenantId,
        shiftId,
        kind: "closing",
        countedTotal: money(counted),
        expectedTotal: money(expected),
        variance: money(variance),
        denominations: input.count.denominations ?? null,
        byUserId: ctx.cashierUserId,
      })
      .returning();

    const closedAt = new Date();
    // The `status = 'open'` guard is the real serialization point: a writer that
    // closed this drawer first leaves no matching row, so this close rolls back
    // whole — no second closing count, no second shift.close event, no rival
    // Z-report. Same discipline the ordering service uses for status
    // transitions, and it holds even against a writer that skipped the lock.
    const [transitioned] = await tx.update(posShifts)
      .set({ status: "closed", closedAt, closedByUserId: ctx.cashierUserId })
      .where(and(eq(posShifts.id, shiftId), eq(posShifts.status, "open")))
      .returning({ id: posShifts.id });
    if (!transitioned) throw new ShiftClosedError();

    await recordAuditEvent(shiftAuditCtx(ctx), {
      action: "shift.close",
      entityType: "pos_shift",
      entityId: shiftId,
      summary: `Shift closed (variance ${money(variance)})`,
      metadata: {
        countId: count.id,
        expected: money(expected),
        counted: money(counted),
        variance: money(variance),
        flagged,
        approvedByUserId,
        closedByUserId: ctx.cashierUserId,
      },
      actorType: "user",
    }, tx);

    const z: ZReport = {
      kind: "z",
      ...core,
      closedByUserId: ctx.cashierUserId,
      closedAt: closedAt.toISOString(),
      cash: { expected, counted, variance },
      flagged,
      approvedByUserId,
    };
    // Blind close: the cashier counts without being told the target.
    if (policy.blindClose && !canManage) {
      return { ...z, cash: { ...z.cash, expected: null, variance: null } };
    }
    return z;
  });
}
