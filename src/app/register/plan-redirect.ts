export type RegisteredPlan = {
  planKey: string | undefined;
  /** Whether planKey matched a row in the plans table. */
  planExists: boolean;
  /**
   * Whether that row costs nothing, read off the same price column PlanCard
   * renders from — see isFreePrice. Previously a local `FREE_PLAN_KEY = "basic"`
   * declared here and again in the subscribe fork, which would have disagreed
   * with the card the moment `basic` was repriced.
   */
  planIsFree: boolean;
};

/**
 * Where registration lands.
 *
 * A validated plan key rather than the general `next` parameter login uses:
 * `next` is an open-redirect surface needing the safeNext guard, while a plan
 * key is a closed set checked against the plans table, so there is nothing to
 * escape.
 *
 * Free is the exception and goes to the dashboard: a new tenant already has it,
 * so highlighting it on billing would be noise.
 */
export function postRegisterHref(v: RegisteredPlan): string {
  if (!v.planKey || !v.planExists || v.planIsFree) return "/dashboard";
  return `/dashboard/settings/billing?plan=${encodeURIComponent(v.planKey)}`;
}
