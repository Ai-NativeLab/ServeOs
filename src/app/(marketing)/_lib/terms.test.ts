import { describe, it, expect } from "vitest";
import { TERMS, termTotal, monthlyEquivalent } from "./terms";

describe("TERMS", () => {
  it("offers three terms starting at a three-month minimum", () => {
    expect(TERMS.map((t) => t.months)).toEqual([3, 6, 12]);
  });

  it("discounts nothing quarterly, a tenth half-yearly, a fifth annually", () => {
    expect(TERMS.map((t) => t.discount)).toEqual([0, 0.1, 0.2]);
  });
});

describe("termTotal", () => {
  it("charges list price for the quarterly term", () => {
    expect(termTotal(499, 3, 0)).toBe(1497);
    expect(termTotal(699, 3, 0)).toBe(2097);
    expect(termTotal(1099, 3, 0)).toBe(3297);
  });

  it("applies the half-yearly discount and rounds to whole pounds", () => {
    expect(termTotal(499, 6, 0.1)).toBe(2695);
    expect(termTotal(699, 6, 0.1)).toBe(3775);
    expect(termTotal(1099, 6, 0.1)).toBe(5935);
  });

  it("applies the annual discount", () => {
    expect(termTotal(499, 12, 0.2)).toBe(4790);
    expect(termTotal(699, 12, 0.2)).toBe(6710);
    expect(termTotal(1099, 12, 0.2)).toBe(10550);
  });

  it("keeps the free tier free on every term", () => {
    for (const t of TERMS) expect(termTotal(0, t.months, t.discount)).toBe(0);
  });
});

describe("monthlyEquivalent", () => {
  it("reports what the discounted term works out to per month", () => {
    expect(monthlyEquivalent(499, 3, 0)).toBe(499);
    expect(monthlyEquivalent(499, 12, 0.2)).toBe(399);
  });

  it("does not divide by zero for the free tier", () => {
    expect(monthlyEquivalent(0, 12, 0.2)).toBe(0);
  });
});
