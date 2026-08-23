import { describe, it, expect } from "vitest";
import { NonFiniteAmountError } from "@/shared/errors";
import { unitRate, formatUnitRate } from "./amounts";

/**
 * `unitRate` is `String(n)` straight into an unbounded Postgres `numeric`, and
 * `numeric` ACCEPTS 'NaN', 'Infinity' and '-Infinity' as literals. So a
 * non-finite number reaching this function does not fail — it persists poison
 * that no later arithmetic can recover from and no screen can repair.
 *
 * Seven purchasing call sites feed it. Guarding each one individually is what
 * the codebase did, and review kept finding sites that had been missed. The
 * floor belongs here, where every one of them passes through.
 */
describe("unitRate", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %p rather than handing Postgres a literal it will happily store",
    (bad) => {
      expect(() => unitRate(bad)).toThrow(NonFiniteAmountError);
    },
  );

  it("still stores an ordinary rate exactly, without money()'s 2dp rounding", () => {
    // The reason unitRate exists at all: a price per gram is legitimately
    // 0.0035, and a case of 24 divides to 2.0833… per can. money() would round
    // both to 0.00 and 2.08 and put the three-way match back onto two bases.
    expect(unitRate(0.0035)).toBe("0.0035");
    expect(unitRate(100 / 48)).toBe("2.0833333333333335");
    expect(unitRate(0)).toBe("0");
    expect(unitRate(-4)).toBe("-4");
  });
});

describe("formatUnitRate", () => {
  it("keeps 2 decimals minimum and 6 maximum so a sub-cent rate is not shown as 0.00", () => {
    expect(formatUnitRate("5")).toBe("5.00");
    expect(formatUnitRate("0.0035")).toBe("0.0035");
    expect(formatUnitRate("2.0833333333333335")).toBe("2.083333");
  });

  it("passes a stored poison value through verbatim rather than rendering NaN", () => {
    // Display-only, and deliberately NOT a throw: a row that is already poisoned
    // must still be viewable so an operator can see what is wrong with it.
    expect(formatUnitRate("NaN")).toBe("NaN");
    expect(formatUnitRate("Infinity")).toBe("Infinity");
  });
});
