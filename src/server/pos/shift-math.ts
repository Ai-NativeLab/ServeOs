/**
 * The drawer's arithmetic — pure, no DB, no I/O.
 *
 * Everything that reasons about how much cash *should* be in a drawer comes
 * through here, so the close path, the X-report, and any later consumer share
 * one implementation of the formula rather than drifting copies.
 */

/** Money rounding, applied to every result so no float noise reaches the DB. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Σ denomination · quantity — e.g. `{ "200": 3, "100": 5, "50": 2 }` → 1200. */
export function sumDenominations(denominations: Record<string, number>): number {
  let total = 0;
  for (const [denom, qty] of Object.entries(denominations)) {
    total += Number(denom) * qty;
  }
  return round2(total);
}

/**
 * The six terms the drawer is made of. All are positive magnitudes — the
 * formula, not the caller, decides which direction each one pulls.
 */
export type ExpectedCashTerms = {
  openingFloat: number;
  /** Σ cash tender `amount` (net of change, excluding tips — tips never enter the drawer math). */
  cashTenders: number;
  /** Σ cash paid back out on refunds. Zero until Spec 3 lands refund tenders. */
  cashRefunds: number;
  payIns: number;
  payOuts: number;
  safeDrops: number;
};

/** The one normative statement of what should be in the drawer. */
export function computeExpectedCash(t: ExpectedCashTerms): number {
  return round2(
    t.openingFloat + t.cashTenders - t.cashRefunds - t.payOuts + t.payIns - t.safeDrops,
  );
}

/** Over is positive, short is negative. */
export function computeVariance(counted: number, expected: number): number {
  return round2(counted - expected);
}

/** A threshold of 0 means "no tolerance": any non-zero variance is flagged. */
export function isVarianceFlagged(variance: number, threshold: number): boolean {
  return Math.abs(variance) > threshold;
}
