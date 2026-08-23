import { describe, it, expect } from "vitest";
import { NonFiniteAmountError } from "@/shared/errors";
import { money } from "./service";

/**
 * `money` is the single formatter that turns a JS number into the 2dp string
 * written to every currency `numeric` column in the product — order totals,
 * refunds, shift reconciliation, cash movements, PO headers, invoice totals.
 *
 * `(Math.round(NaN * 100) / 100).toFixed(2)` is the string "NaN", and Postgres
 * `numeric` accepts it. The column then poisons every SUM it participates in,
 * cannot be compared or ordered meaningfully, and has no repair path in any UI.
 * Failing loudly at the formatter is strictly better than persisting that.
 */
describe("money", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %p rather than emitting a literal Postgres numeric will store",
    (bad) => {
      expect(() => money(bad)).toThrow(NonFiniteAmountError);
    },
  );

  it("names the failure so an operator can tell a bug from bad input", () => {
    expect(() => money(Number.NaN)).toThrow(/finite/i);
  });

  it("rounds to 2 decimals exactly as before for every finite value", () => {
    expect(money(0)).toBe("0.00");
    expect(money(140.79)).toBe("140.79");
    expect(money(-12.5)).toBe("-12.50");
    expect(money(1e15)).toBe("1000000000000000.00");
  });

  it("rounds a half-cent by where the float actually lands, not by the decimal reading", () => {
    // Pinning pre-existing behaviour, not endorsing it, and NOT changed by this
    // PR. `n * 100` rarely lands exactly on .5, so a "half cent" rounds up or
    // down depending on the binary representation:
    //
    //   1.005 * 100 = 100.49999999999999  -> 100  -> 1.00   (down)
    //   0.145 * 100 =  14.499999999999998 ->  14  -> 0.14   (down)
    //   2.675 * 100 = 267.5               -> 268  -> 2.68   (up)
    //   8.345 * 100 = 834.5000000000001   -> 835  -> 8.35   (up)
    //
    // Deterministic, so it never disagrees with itself — but not the banker's
    // or half-up rounding a finance reviewer would assume. Worth its own
    // decision; unrelated to the finiteness floor this PR adds.
    expect(money(1.005)).toBe("1.00");
    expect(money(0.145)).toBe("0.14");
    expect(money(2.675)).toBe("2.68");
    expect(money(8.345)).toBe("8.35");
  });

  it("still accepts a legitimately huge but finite total", () => {
    // The floor is about finiteness, not magnitude. A large order must not be
    // rejected just because it is large.
    expect(() => money(Number.MAX_SAFE_INTEGER)).not.toThrow();
  });
});
