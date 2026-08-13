import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { Store } from "./store";
import { EMPTY_TILL_STATE, reduce } from "./reducer";
import { money, shortCode, snapshotLine, sumDenominations, tillReport, type CachedMenu } from "./till";

const MENU: CachedMenu = {
  categories: [
    {
      products: [
        {
          id: "p1", nameEn: "Tea", nameAr: "شاي", effectivePrice: 10,
          modifierGroups: [
            {
              id: "g1", nameEn: "Milk", nameAr: "حليب",
              options: [
                { id: "o1", nameEn: "Oat", nameAr: "شوفان", priceDelta: "2.50" },
                { id: "o2", nameEn: "Full fat", nameAr: "كامل الدسم", priceDelta: 0 },
              ],
            },
          ],
        },
        {
          id: "p2", nameEn: "Cake", nameAr: "كيك", effectivePrice: 40,
          variants: [{ id: "v1", nameEn: "Slice", nameAr: "شريحة", price: 25 }],
        },
      ],
    },
  ],
};

describe("snapshotLine", () => {
  it("prices a modifier line the way placeOrder does: base + deltas, once per option", () => {
    const snap = snapshotLine(MENU, { productId: "p1", quantity: 2, selectedOptionIds: ["o1", "o1", "o2"] });
    expect(snap).toMatchObject({
      productId: "p1", productNameEn: "Tea", productNameAr: "شاي",
      unitPrice: 12.5, quantity: 2, lineTotal: 25,
    });
    // Deduped: a repeated option must not be charged twice.
    expect(snap.modifiers).toHaveLength(2);
    expect(snap.modifiers?.[0]).toMatchObject({ groupId: "g1", optionId: "o1", optionNameEn: "Oat", priceDelta: 2.5 });
  });

  it("a variant REPLACES the base price and carries no modifiers", () => {
    const snap = snapshotLine(MENU, { productId: "p2", variantId: "v1", quantity: 1, selectedOptionIds: [] });
    expect(snap).toMatchObject({ unitPrice: 25, lineTotal: 25, variantId: "v1", variantNameEn: "Slice" });
    expect(snap.modifiers).toBeUndefined();
  });

  it("a line discount reduces lineTotal and is capped at the line's gross", () => {
    expect(snapshotLine(MENU, { productId: "p1", quantity: 1, selectedOptionIds: [], discountAmount: 3 }))
      .toMatchObject({ unitPrice: 10, discountAmount: 3, lineTotal: 7 });
    expect(snapshotLine(MENU, { productId: "p1", quantity: 1, selectedOptionIds: [], discountAmount: 99 }))
      .toMatchObject({ discountAmount: 10, lineTotal: 0 });
  });

  it("refuses a line the cached catalog cannot resolve rather than inventing a price", () => {
    expect(() => snapshotLine(MENU, { productId: "gone", quantity: 1, selectedOptionIds: [] })).toThrow(/menu/i);
    expect(() => snapshotLine(MENU, { productId: "p2", variantId: "gone", quantity: 1, selectedOptionIds: [] })).toThrow(/menu/i);
    expect(() => snapshotLine(MENU, { productId: "p1", quantity: 1, selectedOptionIds: ["gone"] })).toThrow(/modifier/i);
    expect(() => snapshotLine(undefined, { productId: "p1", quantity: 1, selectedOptionIds: [] })).toThrow();
  });
});

describe("tillReport", () => {
  /** Drives the projection through a real event log — the same path a shift of
   *  offline trading takes — instead of a hand-built TillState. */
  function shiftState() {
    const store = new Store(openDb(":memory:"));
    store.appendEvent("shift.opened", { actorUserId: "u1", clientShiftId: "cs1", openingFloat: 100 });
    store.appendEvent("sale.recorded", {
      actorUserId: "u1", clientOrderId: "o1", clientShiftId: "cs1",
      payments: [{ method: "cash", amount: 60 }], orderDiscountAmount: 5,
    });
    store.appendEvent("sale.recorded", {
      actorUserId: "u1", clientOrderId: "o2", clientShiftId: "cs1",
      payments: [{ method: "card", amount: 30 }],
    });
    store.appendEvent("cash.movement", { actorUserId: "u1", type: "pay_out", amount: 15, reasonCode: "supplier" });
    store.appendEvent("cash.movement", { actorUserId: "u1", type: "no_sale", amount: 0, reasonCode: "change" });
    return reduce(EMPTY_TILL_STATE, store.pendingEvents());
  }

  it("projects the X-report from the event log, with per-method counts and signed movements", () => {
    const report = tillReport("x", shiftState());
    expect(report).toMatchObject({
      kind: "x", shiftId: "cs1", openedByUserId: "u1", openingFloat: 100,
      salesCount: 2, discountTotal: 5, voidTotal: 0, refundTotal: 0,
    });
    expect(report!.tenders).toEqual([
      { method: "cash", amount: 60, tips: 0, count: 1 },
      { method: "card", amount: 30, tips: 0, count: 1 },
    ]);
    // Pay-outs are negative, exactly as the server stores and reports them.
    expect(report!.movements).toEqual([
      { type: "pay_out", total: -15, count: 1 },
      { type: "no_sale", total: 0, count: 1 },
    ]);
    // 100 float + 60 cash − 15 pay-out. The card tender never enters the drawer.
    expect(report!.cash).toEqual({ expected: 145 });
  });

  it("folds a count into the report as counted + variance", () => {
    expect(tillReport("z", shiftState(), 140)!.cash).toEqual({ expected: 145, counted: 140, variance: -5 });
  });

  it("is null with no open drawer — there is nothing to report on", () => {
    expect(tillReport("x", EMPTY_TILL_STATE)).toBeNull();
  });
});

describe("counting helpers", () => {
  it("sums a denomination pad", () => {
    expect(sumDenominations({ "200": 3, "100": 5, "0.5": 2 })).toBe(1101);
    expect(sumDenominations({})).toBe(0);
  });

  it("formats money the way the server's numeric(12,2) columns arrive", () => {
    expect(money(1.005)).toBe("1.01");
    expect(money(-15)).toBe("-15.00");
  });

  it("derives a stable, readable receipt code from the clientOrderId", () => {
    const id = "0f4a1b2c-3d4e-4f50-8a6b-7c8d9e0f1a2b";
    expect(shortCode(id)).toBe("T-0F1A2B");
  });
});
