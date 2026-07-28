import { describe, it, expect } from "vitest";
import { computeExpectedCash, computeVariance, sumDenominations, isVarianceFlagged } from "./shift-math";

describe("computeExpectedCash", () => {
  it("sums the normative formula", () => {
    // float 200 + cash 500 − refunds 0 − payouts 50 + payins 30 − drops 100 = 580
    expect(computeExpectedCash({
      openingFloat: 200, cashTenders: 500, cashRefunds: 0, payOuts: 50, payIns: 30, safeDrops: 100,
    })).toBe(580);
  });

  it("subtracts cash refunds (the Spec 3 term)", () => {
    expect(computeExpectedCash({
      openingFloat: 100, cashTenders: 200, cashRefunds: 25, payOuts: 0, payIns: 0, safeDrops: 0,
    })).toBe(275);
  });

  it("is just the float for a drawer that never traded", () => {
    expect(computeExpectedCash({
      openingFloat: 150, cashTenders: 0, cashRefunds: 0, payOuts: 0, payIns: 0, safeDrops: 0,
    })).toBe(150);
  });

  it("rounds to cents rather than carrying float noise", () => {
    expect(computeExpectedCash({
      openingFloat: 0.1, cashTenders: 0.2, cashRefunds: 0, payOuts: 0, payIns: 0, safeDrops: 0,
    })).toBe(0.3);
  });
});

describe("computeVariance", () => {
  it("is positive for an over and negative for a short", () => {
    expect(computeVariance(585, 580)).toBe(5);
    expect(computeVariance(575, 580)).toBe(-5);
  });

  it("is zero when the drawer balances", () => {
    expect(computeVariance(580, 580)).toBe(0);
  });
});

describe("sumDenominations", () => {
  it("multiplies denomination by quantity", () => {
    expect(sumDenominations({ "200": 3, "100": 5, "50": 2 })).toBe(1200);
  });

  it("is zero for an empty count", () => {
    expect(sumDenominations({})).toBe(0);
  });
});

describe("isVarianceFlagged", () => {
  it("flags only what exceeds the threshold, in either direction", () => {
    expect(isVarianceFlagged(21, 20)).toBe(true);
    expect(isVarianceFlagged(-21, 20)).toBe(true);
    expect(isVarianceFlagged(20, 20)).toBe(false);
    expect(isVarianceFlagged(-20, 20)).toBe(false);
  });

  it("with no threshold set, flags any non-zero variance", () => {
    expect(isVarianceFlagged(0, 0)).toBe(false);
    expect(isVarianceFlagged(0.01, 0)).toBe(true);
    expect(isVarianceFlagged(-0.01, 0)).toBe(true);
  });
});
