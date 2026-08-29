import { describe, it, expect } from "vitest";
import { placeOrder } from "@/server/ordering/service";
import { recordSale } from "@/server/pos/record-sale";
import { recordCashMovement } from "@/server/pos/cash-movements";
import { closeShift } from "@/server/pos/shifts";
import { seedPosContext, openShiftForCtx } from "@/server/pos/test-helpers";
import { buildXReport, buildZReport } from "./pos-reports";

/** Owner cashier with an open 200.00 drawer, one cash sale (20 change), one card sale (tip 5). */
async function seedShiftWithSales() {
  const seeded = await seedPosContext("owner");
  const { ctx, productId, total } = seeded;
  const shift = await openShiftForCtx(ctx); // 200.00 float
  await recordSale(ctx, {
    clientOrderId: "x-cash",
    lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: total,
    payments: [{ clientPaymentId: "xp-1", method: "cash", amount: total, tenderedAmount: total + 20 }],
  });
  await recordSale(ctx, {
    clientOrderId: "x-card",
    lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    expectedTotal: total,
    payments: [{ clientPaymentId: "xp-2", method: "card", amount: total, tipAmount: 5, reference: "4242" }],
  });
  return { ...seeded, shift };
}

describe("POS X report", () => {
  it("is repeatable and non-resetting — identical output twice, no state change", async () => {
    const { ctx, total } = await seedShiftWithSales();
    const a = await buildXReport(ctx);
    const b = await buildXReport(ctx);
    // Pulling it changes nothing: every number is identical. Only the
    // "as of" stamp (window.to) moves, because a snapshot says when it was taken.
    const numbers = ({ window, ...rest }: typeof a) => ({ ...rest, from: window.from });
    expect(numbers(b)).toEqual(numbers(a));
    expect(a.grossSales).toBeCloseTo(total * 2, 2);
    expect(a.orderCount).toBe(2);
    expect(a.tenders).toHaveLength(2);
    expect(a.tips).toBeCloseTo(5, 2);
  });

  it("expectedDrawerCash agrees with Spec 2's drawer formula — float + cash − pay-outs", async () => {
    const { ctx, total } = await seedShiftWithSales();
    // A pay-out mid-shift MUST reduce expected cash; a formula that only sums
    // tenders would overstate the drawer and make the cashier look short.
    await recordCashMovement(ctx, { type: "pay_out", amount: 25, reasonCode: "supplier" });
    const x = await buildXReport(ctx);
    // 200 float + cash amount (tendered − change nets to the amount) − 25 out.
    expect(x.expectedDrawerCash).toBeCloseTo(200 + total - 25, 2);
  });

  it("scopes to the branch and channel='pos' — a web order in the same tenant never appears", async () => {
    const { ctx, tenantId, branchId, productId } = await seedShiftWithSales();
    const before = await buildXReport(ctx);
    await placeOrder(tenantId, {
      branchId, fulfillmentType: "pickup",
      customerName: "Web", customerPhone: "01012345671",
      lines: [{ productId, quantity: 3, selectedOptionIds: [] }],
    });
    const after = await buildXReport(ctx);
    expect(after.grossSales).toBeCloseTo(before.grossSales, 2);
    expect(after.orderCount).toBe(before.orderCount);
  });

  it("perCashier buckets by taken_by_user_id and includes the signed-in cashier", async () => {
    const { ctx } = await seedShiftWithSales();
    const x = await buildXReport(ctx);
    const mine = x.perCashier.find((c) => c.cashierUserId === ctx.cashierUserId);
    expect(mine).toBeTruthy();
    expect(mine!.orders).toBe(2);
    expect(mine!.cashierName).toBe(ctx.cashierName);
  });
});

describe("POS Z report", () => {
  it("before the close: ties to the open shift with countedCash null — not yet counted, not frozen", async () => {
    const { ctx, shift } = await seedShiftWithSales();
    const z = await buildZReport(ctx);
    expect(z.shiftId).toBe(shift.id);
    expect(z.countedCash).toBeNull();
    expect(z.overShort).toBeNull();
    expect(z.frozen).toBe(false);
  });

  it("after the close: reads counted vs expected from cash_counts, and a zero variance is a real 0, not null", async () => {
    const { ctx, shift } = await seedShiftWithSales();
    const x = await buildXReport(ctx);
    // Count exactly what the drawer should hold → variance 0.
    await closeShift(ctx, shift.id, { count: { countedTotal: x.expectedDrawerCash } });

    const z = await buildZReport(ctx, { shiftId: shift.id });
    expect(z.frozen).toBe(true);
    expect(z.countedCash).toBeCloseTo(x.expectedDrawerCash, 2);
    expect(z.overShort).toBe(0); // distinguishable from null = "count never happened"
    expect(z.grossSales).toBeCloseTo(x.grossSales, 2);
  });
});
