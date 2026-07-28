import { describe, it, expect } from "vitest";
import {
  sumDenominations, compactDenominations, parseAmount, denominationsAgree,
  varianceLabel, formatAmount,
} from "./counting";

describe("sumDenominations", () => {
  it("multiplies each denomination by its quantity", () => {
    expect(sumDenominations({ "200": 3, "100": 5, "50": 2 })).toBe(1200);
  });

  it("is zero for an untouched pad", () => {
    expect(sumDenominations({})).toBe(0);
    expect(sumDenominations({ "200": 0, "100": 0 })).toBe(0);
  });

  it("handles fractional coins without float drift", () => {
    expect(sumDenominations({ "0.25": 3 })).toBe(0.75);
    expect(sumDenominations({ "0.1": 3 })).toBe(0.3);
  });

  it("ignores rows that are not numbers", () => {
    expect(sumDenominations({ "100": Number.NaN, "50": 2 })).toBe(100);
  });
});

describe("compactDenominations", () => {
  it("keeps only the rows that were actually counted", () => {
    expect(compactDenominations({ "200": 2, "100": 0, "50": 3 })).toEqual({ "200": 2, "50": 3 });
  });
});

describe("parseAmount", () => {
  it("reads a plain amount", () => {
    expect(parseAmount("200")).toBe(200);
    expect(parseAmount(" 12.5 ")).toBe(12.5);
  });

  it("rounds to cents", () => {
    expect(parseAmount("10.005")).toBe(10.01);
  });

  it("rejects blanks, words and negatives", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("   ")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("-5")).toBeNull();
  });

  it("accepts zero — an empty drawer is a legitimate count", () => {
    expect(parseAmount("0")).toBe(0);
  });
});

describe("denominationsAgree", () => {
  it("passes when the pad matches the typed total", () => {
    expect(denominationsAgree({ "100": 2, "50": 1 }, 250)).toBe(true);
  });

  it("fails when it does not — the same rule the server enforces", () => {
    expect(denominationsAgree({ "100": 2 }, 250)).toBe(false);
  });

  it("compares at cent precision", () => {
    expect(denominationsAgree({ "0.1": 3 }, 0.3)).toBe(true);
  });
});

describe("varianceLabel", () => {
  it("names an over, a short and a balanced drawer", () => {
    expect(varianceLabel(5)).toBe("over");
    expect(varianceLabel(-5)).toBe("short");
    expect(varianceLabel(0)).toBe("balanced");
  });

  it("treats sub-cent noise as balanced", () => {
    expect(varianceLabel(0.001)).toBe("balanced");
  });
});

describe("formatAmount", () => {
  it("always shows two decimals", () => {
    expect(formatAmount(200)).toBe("200.00");
    expect(formatAmount(-4.5)).toBe("-4.50");
  });
});
