/**
 * Billing terms shown on the pricing section. Quarterly is the minimum
 * commitment — there is no monthly term by design.
 *
 * These are DISPLAY maths only. What a subscription actually records when a
 * term is chosen is owned by the plans/billing spec, not by this page.
 */
export const TERMS = [
  { key: "quarterly", months: 3, discount: 0 },
  { key: "halfYearly", months: 6, discount: 0.1 },
  { key: "annual", months: 12, discount: 0.2 },
] as const;

export type Term = (typeof TERMS)[number];
export type TermKey = Term["key"];

/** Total charged for one term, in whole pounds. */
export function termTotal(priceMonthly: number, months: number, discount: number): number {
  return Math.round(priceMonthly * months * (1 - discount));
}

/** What that total works out to per month — the number buyers compare on. */
export function monthlyEquivalent(priceMonthly: number, months: number, discount: number): number {
  return Math.round(termTotal(priceMonthly, months, discount) / months);
}
