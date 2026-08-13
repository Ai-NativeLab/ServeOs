import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { Store } from "./store";
import { reduce, expectedCash, EMPTY_TILL_STATE, type TillState } from "./reducer";

/** Builds a real event log through the store (not hand-rolled EventRow
 *  literals) so the reducer is exercised against exactly what appendEvent
 *  produces — real seq assignment, real JSON round-trip. */
function makeStore(): Store {
  return new Store(openDb(":memory:"));
}

describe("reduce", () => {
  it("shift.opened sets openShift from the payload and the event's occurred_at", () => {
    const s = makeStore();
    s.appendEvent("shift.opened", { clientShiftId: "cs1", openingFloat: 100, actorUserId: "u1" });
    const state = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(state.openShift).toMatchObject({ clientShiftId: "cs1", openingFloat: 100, openedByUserId: "u1" });
    expect(typeof state.openShift?.openedAt).toBe("string");
  });

  it("sale.recorded accumulates tenders by method, sales count, and discount total", () => {
    const s = makeStore();
    s.appendEvent("shift.opened", { clientShiftId: "cs1", openingFloat: 100, actorUserId: "u1" });
    s.appendEvent("sale.recorded", {
      clientOrderId: "o1",
      clientShiftId: "cs1",
      payments: [{ method: "cash", amount: 50 }],
      orderDiscountAmount: 5,
    });
    s.appendEvent("sale.recorded", {
      clientOrderId: "o2",
      clientShiftId: "cs1",
      payments: [{ method: "card", amount: 30 }, { method: "cash", amount: 10 }],
    });
    const state = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(state.salesCount).toBe(2);
    expect(state.tendersByMethod).toEqual({ cash: 60, card: 30, other: 0 });
    expect(state.tenderCounts).toEqual({ cash: 2, card: 1, other: 0 });
    expect(state.discountTotal).toBe(5);
  });

  it("discountTotal counts LINE discounts as well as the order-level one", () => {
    const s = makeStore();
    s.appendEvent("sale.recorded", {
      clientOrderId: "o1",
      clientShiftId: "cs1",
      payments: [{ method: "cash", amount: 40 }],
      lines: [{ discountAmount: 3 }, { discountAmount: 1.5 }, {}],
      orderDiscountAmount: 5,
    });
    // Reading orderDiscountAmount alone would report 5 and under-report the
    // real 9.50 the customer was given (client wire contract rule 4).
    expect(reduce(EMPTY_TILL_STATE, s.pendingEvents()).discountTotal).toBe(9.5);
  });

  it("cash.movement accumulates pay-ins, pay-outs, safe drops, and counts no-sales", () => {
    const s = makeStore();
    s.appendEvent("cash.movement", { type: "pay_in", amount: 20 });
    s.appendEvent("cash.movement", { type: "pay_out", amount: 15 });
    s.appendEvent("cash.movement", { type: "safe_drop", amount: 100 });
    s.appendEvent("cash.movement", { type: "no_sale", amount: 0 });
    s.appendEvent("cash.movement", { type: "no_sale", amount: 0 });
    const state = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(state.movements).toEqual({ payIn: 20, payOut: 15, safeDrop: 100, noSaleCount: 2 });
    expect(state.movementCounts).toEqual({ payIn: 1, payOut: 1, safeDrop: 1 });
  });

  it("shift.closed nulls openShift", () => {
    const s = makeStore();
    s.appendEvent("shift.opened", { clientShiftId: "cs1", openingFloat: 100, actorUserId: "u1" });
    s.appendEvent("shift.closed", {});
    const state = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(state.openShift).toBeNull();
  });

  it("ticket.held then ticket.recalled round-trips: held, then gone", () => {
    const s = makeStore();
    s.appendEvent("ticket.held", { clientTicketId: "ct1", label: "Table 4", draft: { lines: [] } });
    const afterHold = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(afterHold.heldTickets).toMatchObject([
      { clientTicketId: "ct1", label: "Table 4", draft: { lines: [] } },
    ]);
    expect(typeof afterHold.heldTickets[0].createdAt).toBe("string");

    s.appendEvent("ticket.recalled", { clientTicketId: "ct1" });
    const afterRecall = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(afterRecall.heldTickets).toEqual([]);
  });

  it("ticket.discarded also removes a held ticket", () => {
    const s = makeStore();
    s.appendEvent("ticket.held", { clientTicketId: "ct1", label: "Table 4", draft: {} });
    s.appendEvent("ticket.discarded", { clientTicketId: "ct1" });
    const state = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(state.heldTickets).toEqual([]);
  });

  it("unknown/audit-only event types (grant.issued, session.signed_in) leave state untouched", () => {
    const s = makeStore();
    s.appendEvent("grant.issued", { permission: "pos:discount", authorizedByUserId: "u9" });
    s.appendEvent("session.signed_in", { userId: "u1" });
    const state = reduce(EMPTY_TILL_STATE, s.pendingEvents());
    expect(state).toEqual(EMPTY_TILL_STATE);
  });

  it("reduces from a non-empty confirmed snapshot, not just the empty zero value", () => {
    const snapshot: TillState = {
      ...EMPTY_TILL_STATE,
      openShift: { clientShiftId: "cs1", openedAt: "2026-08-13T08:00:00Z", openingFloat: 200, openedByUserId: "u1" },
      salesCount: 3,
    };
    const s = makeStore();
    s.appendEvent("cash.movement", { type: "pay_in", amount: 10 });
    const state = reduce(snapshot, s.pendingEvents());
    expect(state.openShift?.openingFloat).toBe(200);
    expect(state.salesCount).toBe(3);
    expect(state.movements.payIn).toBe(10);
  });

  it("is deterministic: replaying the same event list twice yields deep-equal state", () => {
    const s = makeStore();
    s.appendEvent("shift.opened", { clientShiftId: "cs1", openingFloat: 100, actorUserId: "u1" });
    s.appendEvent("sale.recorded", {
      clientOrderId: "o1", clientShiftId: "cs1", payments: [{ method: "cash", amount: 25 }], orderDiscountAmount: 2,
    });
    s.appendEvent("cash.movement", { type: "pay_out", amount: 5 });
    s.appendEvent("ticket.held", { clientTicketId: "ct1", label: "Bar 2", draft: {} });

    const events = s.pendingEvents();
    const first = reduce(EMPTY_TILL_STATE, events);
    const second = reduce(EMPTY_TILL_STATE, events);
    expect(second).toEqual(first);
    // And the snapshot itself was never mutated by either run.
    expect(EMPTY_TILL_STATE).toEqual({
      openShift: null,
      tendersByMethod: { cash: 0, card: 0, other: 0 },
      tenderCounts: { cash: 0, card: 0, other: 0 },
      movements: { payIn: 0, payOut: 0, safeDrop: 0, noSaleCount: 0 },
      movementCounts: { payIn: 0, payOut: 0, safeDrop: 0 },
      salesCount: 0,
      discountTotal: 0,
      heldTickets: [],
    });
  });
});

describe("expectedCash", () => {
  it("is openingFloat + cash − payOut − safeDrop + payIn", () => {
    const state: TillState = {
      ...EMPTY_TILL_STATE,
      openShift: { clientShiftId: "cs1", openedAt: "t", openingFloat: 100, openedByUserId: "u1" },
      tendersByMethod: { cash: 60, card: 30, other: 0 },
      movements: { payIn: 20, payOut: 15, safeDrop: 10, noSaleCount: 0 },
    };
    // 100 + 60 - 15 - 10 + 20 = 155
    expect(expectedCash(state)).toBe(155);
  });

  it("is just the tender/movement math when there is no open shift (openingFloat 0)", () => {
    const state: TillState = {
      ...EMPTY_TILL_STATE,
      tendersByMethod: { cash: 10, card: 0, other: 0 },
    };
    expect(expectedCash(state)).toBe(10);
  });
});
