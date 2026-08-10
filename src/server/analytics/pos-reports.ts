import { sql, and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import type { PosCashierContext } from "@/server/pos/require-cashier";
import {
  buildXReport as buildShiftXReport,
  findOpenShift,
} from "@/server/pos/shifts";
import { posShifts, cashCounts } from "@/server/pos/shift-schema";
import { tableExists } from "./deps";

/**
 * The POS operational reports, served through the bridge and scoped to the
 * signed-in device/branch by requirePosCashier (cross-device isolation is the
 * guard's job and is tested at the route layer — not re-tested here).
 *
 * X is a peek: business-day totals for this branch, repeatable, identical
 * output, resets nothing. Z is the close: the same totals tied to a shift,
 * with counted-vs-expected once the drawer has been counted.
 *
 * Persisting/freezing the Z snapshot at shift close is owned by Spec 2's
 * close transaction (closeShift). These builders provide the numbers — they
 * do not own the lifecycle. expectedDrawerCash likewise delegates to Spec 2's
 * shift report so there is exactly ONE drawer formula (shift-math.ts), never
 * a drifting copy here. Money definitions: docs/ailab/specs/reporting-metrics.md.
 */

export type PosReport = {
  window: { from: string; to: string };
  grossSales: number;
  orderCount: number;
  tenders: { method: string; amount: number; count: number }[];
  tips: number;
  discounts: number;
  voids: number;
  refunds: number;
  perCashier: { cashierUserId: string; cashierName: string | null; sales: number; orders: number }[];
  expectedDrawerCash: number;
};

export type ZReport = PosReport & {
  shiftId: string | null;
  countedCash: number | null;
  overShort: number | null;
  frozen: boolean;
};

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** Day totals for the branch: sold POS orders placed today (tenant timezone). */
async function gatherDayTotals(tx: Tx, branchId: string): Promise<Omit<PosReport, "expectedDrawerCash">> {
  // The window is the tenant's business day: local midnight to now.
  const [{ rows: windowRows }, { rows: totals }, { rows: tenderRows }, { rows: adjRows }, { rows: cashierRows }] =
    await Promise.all([
      tx.execute<{ from: string; to: string }>(sql`
        SELECT date_trunc('day', now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone AS from, now() AS to
        FROM tenants t LIMIT 1
      `),
      tx.execute<{ gross: string; order_count: string }>(sql`
        SELECT COALESCE(SUM(total), 0) AS gross, COUNT(*) AS order_count
        FROM orders
        WHERE branch_id = ${branchId} AND channel = 'pos'
          AND status NOT IN ('cancelled', 'rejected')
          AND placed_at >= date_trunc('day', now() AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1))
                           AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1)
      `),
      tx.execute<{ method: string; amount: string; count: string; tips: string }>(sql`
        SELECT op.method, COALESCE(SUM(op.amount), 0) AS amount, COUNT(*) AS count,
               COALESCE(SUM(op.tip_amount), 0) AS tips
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        WHERE o.branch_id = ${branchId} AND o.channel = 'pos'
          AND o.status NOT IN ('cancelled', 'rejected')
          AND o.placed_at >= date_trunc('day', now() AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1))
                             AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1)
        GROUP BY op.method
      `),
      tx.execute<{ kind: string; amount: string }>(sql`
        SELECT CASE WHEN e.type IN ('line_discount','order_discount') THEN 'discount' ELSE 'void' END AS kind,
               COALESCE(SUM(e.amount), 0) AS amount
        FROM pos_adjustment_events e
        JOIN orders o ON o.id = e.order_id
        WHERE o.branch_id = ${branchId} AND o.channel = 'pos'
          AND o.status NOT IN ('cancelled', 'rejected')
          AND o.placed_at >= date_trunc('day', now() AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1))
                             AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1)
        GROUP BY 1
      `),
      tx.execute<{ cashier_user_id: string; cashier_name: string | null; sales: string; orders: string }>(sql`
        SELECT op.taken_by_user_id AS cashier_user_id, u.name AS cashier_name,
               COALESCE(SUM(op.amount), 0) AS sales, COUNT(DISTINCT op.order_id) AS orders
        FROM order_payments op
        JOIN orders o ON o.id = op.order_id
        LEFT JOIN users u ON u.id = op.taken_by_user_id
        WHERE o.branch_id = ${branchId} AND o.channel = 'pos'
          AND o.status NOT IN ('cancelled', 'rejected')
          AND o.placed_at >= date_trunc('day', now() AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1))
                             AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1)
        GROUP BY op.taken_by_user_id, u.name
        ORDER BY sales DESC
      `),
    ]);

  // Refunds: Spec 3's table is read through the guard; 0 until it ships.
  let refunds = 0;
  if (await tableExists(tx, "refunds")) {
    const { rows } = await tx.execute<{ amount: string }>(sql`
      SELECT COALESCE(SUM(total_amount), 0) AS amount FROM refunds
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1))
                          AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1)
    `);
    refunds = Number(rows[0]?.amount ?? 0);
  }

  const adj = Object.fromEntries(adjRows.map((r) => [r.kind, Number(r.amount)]));
  return {
    window: { from: new Date(windowRows[0].from).toISOString(), to: new Date(windowRows[0].to).toISOString() },
    grossSales: Number(totals[0]?.gross ?? 0),
    orderCount: Number(totals[0]?.order_count ?? 0),
    tenders: tenderRows.map((r) => ({ method: r.method, amount: Number(r.amount), count: Number(r.count) })),
    tips: tenderRows.reduce((s, r) => s + Number(r.tips), 0),
    discounts: adj.discount ?? 0,
    voids: adj.void ?? 0,
    refunds,
    perCashier: cashierRows.map((r) => ({
      cashierUserId: r.cashier_user_id, cashierName: r.cashier_name,
      sales: Number(r.sales), orders: Number(r.orders),
    })),
  };
}

/** Expected drawer cash for THIS device — Spec 2's formula when a shift exists. */
async function expectedCashForDevice(ctx: PosCashierContext, dayCash: number): Promise<number> {
  const shift = await findOpenShift(ctx.tenantId, ctx.deviceId);
  if (shift) {
    // One formula: float + cash tenders − pay-outs + pay-ins − safe drops,
    // computed by the shift domain — exactly what the close will assert.
    const x = await buildShiftXReport(ctx.tenantId, shift);
    return x.cash.expected;
  }
  // No open drawer: the only cash is what today's tenders put somewhere.
  return dayCash;
}

export async function buildXReport(ctx: PosCashierContext): Promise<PosReport> {
  const day = await withTenant(ctx.tenantId, (tx) => gatherDayTotals(tx, ctx.branchId));
  const cash = day.tenders.find((t) => t.method === "cash")?.amount ?? 0;
  const expectedDrawerCash = await expectedCashForDevice(ctx, cash);
  return { ...day, expectedDrawerCash };
}

export async function buildZReport(ctx: PosCashierContext, opts?: { shiftId?: string }): Promise<ZReport> {
  const base = await buildXReport(ctx);

  return withTenant(ctx.tenantId, async (tx) => {
    if (!(await tableExists(tx, "pos_shifts"))) {
      // Pre-Spec-2 fallback the spec names: day window, nothing to count against.
      return { ...base, shiftId: null, countedCash: null, overShort: null, frozen: false };
    }

    // The shift this Z is about: the one asked for, else this device's open one.
    const [shift] = opts?.shiftId
      ? await tx.select().from(posShifts)
          .where(and(eq(posShifts.id, opts.shiftId), eq(posShifts.deviceId, ctx.deviceId)))
          .limit(1)
      : await tx.select().from(posShifts)
          .where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open")))
          .limit(1);
    if (!shift) return { ...base, shiftId: null, countedCash: null, overShort: null, frozen: false };

    // Counted vs expected exists only once the close recorded a closing count.
    // null here means "not counted yet" — a balanced drawer reports a real 0.
    const [closing] = await tx.select().from(cashCounts)
      .where(and(eq(cashCounts.shiftId, shift.id), eq(cashCounts.kind, "closing")))
      .limit(1);

    return {
      ...base,
      shiftId: shift.id,
      countedCash: closing ? Number(closing.countedTotal) : null,
      overShort: closing ? Number(closing.variance) : null,
      frozen: shift.status === "closed",
    };
  });
}
