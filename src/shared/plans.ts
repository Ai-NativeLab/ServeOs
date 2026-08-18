/**
 * What "free" means, in one place.
 *
 * It was previously three declarations across two semantics: PlanCard asked
 * `Number(plan.priceMonthly) === 0` to decide what to render, while the
 * subscribe fork and the post-register redirect each declared their own
 * `FREE_PLAN_KEY = "basic"`. Repricing `basic` would have made the card say
 * "Start free" while the fork rendered the sales enquiry form.
 *
 * The price column is the honest definition — a plan is free when it costs
 * nothing, not when it holds a particular key — so the routing decisions now
 * take a boolean derived from the same expression the card renders from.
 *
 * Pure and dependency-free on purpose: PlanCard is a client component, so it
 * cannot import from @/server/subscription where the Plan type lives.
 */
export function isFreePrice(priceMonthly: string | number): boolean {
  return Number(priceMonthly) === 0;
}
