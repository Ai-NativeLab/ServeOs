/** The free plan is what a new tenant already gets; there is nothing to highlight. */
const FREE_PLAN_KEY = "basic";

/**
 * Where registration lands.
 *
 * A validated plan key rather than the general `next` parameter login uses:
 * `next` is an open-redirect surface needing the safeNext guard, while a plan
 * key is a closed set checked against the plans table, so there is nothing to
 * escape.
 */
export function postRegisterHref(planKey: string | undefined, planExists: boolean): string {
  if (!planKey || !planExists || planKey === FREE_PLAN_KEY) return "/dashboard";
  return `/dashboard/settings/billing?plan=${encodeURIComponent(planKey)}`;
}
