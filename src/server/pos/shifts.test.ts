import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "@/server/audit/schema";
import { tenantSettings } from "@/server/tenancy/schema";
import { openShift, findOpenShift, closeShift, buildXReport } from "./shifts";
import { recordCashMovement } from "./cash-movements";
import { recordSale } from "./record-sale";
import { issueGrant } from "./grants";
import { posShifts, cashCounts } from "./shift-schema";
import {
  ShiftAlreadyOpenError, CashCountMismatchError, ShiftClosedError, PosForbiddenError,
} from "./errors";
import { seedPosContext } from "./test-helpers";
import type { PosCashierContext } from "./require-cashier";
import type { Permission } from "@/server/rbac/permissions";

/** The same terminal, a different human behind it. */
function asCashier(ctx: PosCashierContext, cashierUserId: string, permissions: Permission[]): PosCashierContext {
  return { ...ctx, cashierUserId, permissions };
}

async function setShiftPolicy(
  tenantId: string,
  shiftPolicy: { blindClose?: boolean; payoutThreshold?: number; varianceThreshold?: number },
) {
  await withTenant(tenantId, (tx) => tx.insert(tenantSettings).values({ tenantId, data: { shiftPolicy } }));
}

describe("openShift", () => {
  it("opens the drawer with an opening float and a matching opening count", async () => {
    const { ctx } = await seedPosContext("owner");

    const shift = await openShift(ctx, { openingFloat: 200 });

    expect(shift.status).toBe("open");
    expect(shift.openingFloat).toBe("200.00");
    expect(shift.openedByUserId).toBe(ctx.cashierUserId);
    expect(shift.closedByUserId).toBeNull();
    expect(shift.closedAt).toBeNull();
    expect(shift.deviceId).toBe(ctx.deviceId);
    expect(shift.branchId).toBe(ctx.branchId);

    const counts = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.shiftId, shift.id)),
    );
    expect(counts).toHaveLength(1);
    // The opening count is the float by definition: counted IS expected, so the
    // shift starts with zero variance.
    expect(counts[0].kind).toBe("opening");
    expect(counts[0].countedTotal).toBe("200.00");
    expect(counts[0].expectedTotal).toBe("200.00");
    expect(counts[0].variance).toBe("0.00");
    expect(counts[0].byUserId).toBe(ctx.cashierUserId);
  });

  it("enforces one open shift per device", async () => {
    const { ctx } = await seedPosContext("owner");
    await openShift(ctx, { openingFloat: 100 });

    await expect(openShift(ctx, { openingFloat: 100 })).rejects.toBeInstanceOf(ShiftAlreadyOpenError);

    const open = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(and(eq(posShifts.deviceId, ctx.deviceId), eq(posShifts.status, "open"))),
    );
    expect(open).toHaveLength(1);
  });

  it("stores the denominations behind the float", async () => {
    const { ctx } = await seedPosContext("owner");

    const shift = await openShift(ctx, { openingFloat: 300, denominations: { "100": 2, "50": 2 } });

    const [count] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.shiftId, shift.id)),
    );
    expect(count.denominations).toEqual({ "100": 2, "50": 2 });
  });

  it("refuses denominations that do not sum to the float, writing nothing", async () => {
    const { ctx } = await seedPosContext("owner");

    await expect(
      openShift(ctx, { openingFloat: 300, denominations: { "100": 2 } }),
    ).rejects.toBeInstanceOf(CashCountMismatchError);

    const shifts = await withTenant(ctx.tenantId, (tx) => tx.select().from(posShifts));
    expect(shifts).toHaveLength(0);
  });

  it("appends exactly one shift.open audit event carrying the float", async () => {
    const { ctx } = await seedPosContext("owner");

    const shift = await openShift(ctx, { openingFloat: 150 });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "shift.open")),
    );
    expect(events).toHaveLength(1);
    expect(events[0].entityType).toBe("pos_shift");
    expect(events[0].entityId).toBe(shift.id);
    expect(events[0].actorUserId).toBe(ctx.cashierUserId);
    expect(events[0].metadata).toMatchObject({ deviceId: ctx.deviceId, openingFloat: "150.00" });
  });
});

describe("findOpenShift", () => {
  it("returns the device's open shift", async () => {
    const { ctx } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });

    const found = await findOpenShift(ctx.tenantId, ctx.deviceId);
    expect(found?.id).toBe(shift.id);
  });

  it("returns null for a device with no open shift", async () => {
    const { ctx } = await seedPosContext("owner");
    expect(await findOpenShift(ctx.tenantId, ctx.deviceId)).toBeNull();
  });

  it("never sees another tenant's shift", async () => {
    const a = await seedPosContext("owner");
    const b = await seedPosContext("owner");
    await openShift(a.ctx, { openingFloat: 100 });

    // Tenant B asking about tenant A's drawer gets nothing — RLS, not a filter.
    expect(await findOpenShift(b.ctx.tenantId, a.ctx.deviceId)).toBeNull();
  });
});

/** A drawer that has traded: float 200, one cash sale, +30 in, −50 out, −100 dropped. */
async function tradedShift(role: "owner" | "manager" | "staff" = "owner") {
  const seeded = await seedPosContext(role);
  const { ctx, productId, total } = seeded;
  const shift = await openShift(ctx, { openingFloat: 200 });
  await recordSale(ctx, {
    clientOrderId: `sale-${shift.id}`,
    lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: total,
    payments: [{ clientPaymentId: `p-${shift.id}`, method: "cash", amount: total, tenderedAmount: total }],
  });
  await recordCashMovement(ctx, { type: "pay_in", amount: 30, reasonCode: "float_top_up" });
  await recordCashMovement(ctx, { type: "pay_out", amount: 50, reasonCode: "supplier" });
  await recordCashMovement(ctx, { type: "safe_drop", amount: 100, reasonCode: "drop" });
  // float + cash − payouts + payins − drops
  const expected = 200 + total - 50 + 30 - 100;
  return { ...seeded, shift, expected };
}

describe("closeShift", () => {
  it("writes a closing count and closes the drawer", async () => {
    const { ctx, shift, expected } = await tradedShift();

    const z = await closeShift(ctx, shift.id, { count: { countedTotal: expected } });

    expect(z.cash.expected).toBe(expected);
    expect(z.cash.counted).toBe(expected);
    expect(z.cash.variance).toBe(0);
    expect(z.flagged).toBe(false);

    const [count] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.kind, "closing")));
    expect(count.expectedTotal).toBe(expected.toFixed(2));
    expect(count.countedTotal).toBe(expected.toFixed(2));
    expect(count.variance).toBe("0.00");

    const [closed] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.id, shift.id)));
    expect(closed.status).toBe("closed");
    expect(closed.closedByUserId).toBe(ctx.cashierUserId);
    expect(closed.closedAt).not.toBeNull();
  });

  it("reports an over and a short with the right sign", async () => {
    const over = await tradedShift();
    const zOver = await closeShift(over.ctx, over.shift.id, { count: { countedTotal: over.expected + 5 } });
    expect(zOver.cash.variance).toBe(5);

    const short = await tradedShift();
    const zShort = await closeShift(short.ctx, short.shift.id, { count: { countedTotal: short.expected - 5 } });
    expect(zShort.cash.variance).toBe(-5);
  });

  it("leaves tips out of the drawer math", async () => {
    const { ctx, productId, total } = await seedPosContext("owner");
    const shift = await openShift(ctx, { openingFloat: 100 });
    await recordSale(ctx, {
      clientOrderId: "tipped",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
      expectedTotal: total,
      payments: [{ clientPaymentId: "p-1", method: "cash", amount: total, tipAmount: 10, tenderedAmount: total }],
    });

    const z = await closeShift(ctx, shift.id, { count: { countedTotal: 100 + total } });
    expect(z.cash.expected).toBe(100 + total); // the 10 tip is not drawer cash
    expect(z.cash.variance).toBe(0);
  });

  it("refuses a count whose denominations do not add up", async () => {
    const { ctx, shift, expected } = await tradedShift();
    await expect(
      closeShift(ctx, shift.id, { count: { countedTotal: expected, denominations: { "100": 1 } } }),
    ).rejects.toBeInstanceOf(CashCountMismatchError);
  });

  it("refuses a second close and writes no second count", async () => {
    const { ctx, shift, expected } = await tradedShift();
    await closeShift(ctx, shift.id, { count: { countedTotal: expected } });

    await expect(closeShift(ctx, shift.id, { count: { countedTotal: expected } }))
      .rejects.toBeInstanceOf(ShiftClosedError);

    const closing = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.kind, "closing")));
    expect(closing).toHaveLength(1);
  });

  it("blind close withholds expected and variance from a plain cashier, but still persists them", async () => {
    const { ctx, tenantId, shift, expected } = await tradedShift("staff");
    await setShiftPolicy(tenantId, { blindClose: true });

    const z = await closeShift(ctx, shift.id, { count: { countedTotal: expected + 7 } });

    expect(z.cash.expected).toBeNull();
    expect(z.cash.variance).toBeNull();
    expect(z.cash.counted).toBe(expected + 7);

    // The drawer's truth is recorded either way — blind close hides it from the
    // cashier, it does not stop the business knowing.
    const [count] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(cashCounts).where(eq(cashCounts.kind, "closing")));
    expect(count.expectedTotal).toBe(expected.toFixed(2));
    expect(count.variance).toBe("7.00");
  });

  it("blind close reveals the numbers to a reconciliation:manage grant", async () => {
    const { ctx, tenantId, managerId, shift, expected } = await tradedShift("staff");
    await setShiftPolicy(tenantId, { blindClose: true });
    const token = issueGrant(tenantId, "reconciliation:manage", managerId);

    const z = await closeShift(ctx, shift.id, {
      count: { countedTotal: expected },
      grants: [{ permission: "reconciliation:manage", token }],
    });

    expect(z.cash.expected).toBe(expected);
    expect(z.cash.variance).toBe(0);
  });

  it("forbids closing another cashier's drawer with only pos:sell", async () => {
    const { ctx, managerId, shift, expected } = await tradedShift("staff");
    const other = asCashier(ctx, managerId, ["pos:sell"]);

    await expect(closeShift(other, shift.id, { count: { countedTotal: expected } }))
      .rejects.toBeInstanceOf(PosForbiddenError);

    const [stillOpen] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.id, shift.id)));
    expect(stillOpen.status).toBe("open");
  });

  it("allows a manager to close another cashier's drawer", async () => {
    const { ctx, managerId, shift, expected } = await tradedShift("staff");
    const manager = asCashier(ctx, managerId, ["pos:sell", "reconciliation:manage"]);

    const z = await closeShift(manager, shift.id, { count: { countedTotal: expected } });

    expect(z.closedByUserId).toBe(managerId);
    expect(z.closedByUserId).not.toBe(shift.openedByUserId);
  });

  it("spends a single grant on both the cross-user close and the variance approval", async () => {
    const { ctx, tenantId, managerId, shift, expected } = await tradedShift("staff");
    await setShiftPolicy(tenantId, { varianceThreshold: 1 });
    const other = asCashier(ctx, managerId, ["pos:sell"]);
    const token = issueGrant(tenantId, "reconciliation:manage", managerId);

    // Grants are single-use, so a close that is BOTH cross-user and flagged must
    // resolve the authorizer once rather than consuming the token twice.
    const z = await closeShift(other, shift.id, {
      count: { countedTotal: expected + 10 },
      grants: [{ permission: "reconciliation:manage", token }],
    });

    expect(z.flagged).toBe(true);
    expect(z.approvedByUserId).toBe(managerId);
  });

  it("emits shift.close carrying the variance, the flag and the approver", async () => {
    const { ctx, tenantId, shift, expected } = await tradedShift("owner");
    await setShiftPolicy(tenantId, { varianceThreshold: 1 });

    await closeShift(ctx, shift.id, { count: { countedTotal: expected - 4 } });

    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "shift.close")));
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(shift.id);
    expect(events[0].metadata).toMatchObject({
      expected: expected.toFixed(2),
      counted: (expected - 4).toFixed(2),
      variance: "-4.00",
      flagged: true,
      approvedByUserId: ctx.cashierUserId,
    });
  });
});

describe("buildXReport", () => {
  it("is non-resetting: the same live expected, no count written, drawer still open", async () => {
    const { ctx, shift, expected } = await tradedShift();

    const first = await buildXReport(ctx.tenantId, shift);
    const second = await buildXReport(ctx.tenantId, shift);

    expect(first.cash.expected).toBe(expected);
    expect(second.cash.expected).toBe(expected);

    const counts = await withTenant(ctx.tenantId, (tx) => tx.select().from(cashCounts));
    expect(counts).toHaveLength(1); // the opening count, and nothing else
    expect(counts[0].kind).toBe("opening");

    const [still] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(posShifts).where(eq(posShifts.id, shift.id)));
    expect(still.status).toBe("open");
  });

  it("totals tenders by method, counts the sales, and lists the movements", async () => {
    const { ctx, shift, total } = await tradedShift();

    const x = await buildXReport(ctx.tenantId, shift);

    expect(x.salesCount).toBe(1);
    expect(x.openingFloat).toBe(200);
    expect(x.tenders).toEqual([{ method: "cash", amount: total, tips: 0, count: 1 }]);
    expect(x.movements).toEqual(expect.arrayContaining([
      { type: "pay_in", total: 30, count: 1 },
      { type: "pay_out", total: -50, count: 1 },
      { type: "safe_drop", total: -100, count: 1 },
    ]));
  });
});
