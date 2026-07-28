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
