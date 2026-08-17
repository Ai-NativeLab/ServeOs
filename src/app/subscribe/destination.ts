import { isDemoSlug } from "@/server/demo/entry";

/** The free plan self-serves: there is nothing to sell and nothing to invoice. */
const FREE_PLAN_KEY = "basic";

export type SubscribeVisitor = {
  planKey: string | undefined;
  /** Whether planKey matched a row in the plans table. Never trust the query string. */
  planExists: boolean;
  /** The signed-in tenant's slug, or null when signed out or without a tenant. */
  tenantSlug: string | null;
};

export type SubscribeDestination =
  | { kind: "redirect"; href: string }
  | { kind: "enquire"; planKey: string };

/**
 * Where "I want this plan" leads.
 *
 * A demo session deliberately does NOT count as a customer. The marketing page
 * hands out a real session via /api/demo/login one click earlier, so treating
 * "signed in" as "is a customer" delivered prospects into the demo tenant's
 * billing page — its usage meters, and a Subscribe button that would raise an
 * invoice against a tenant reset nightly.
 *
 * Extracted from the page so these rules are testable without a browser. The
 * page is a thin wrapper: it resolves the visitor, then does what this says.
 */
export function subscribeDestination(v: SubscribeVisitor): SubscribeDestination {
  // An unknown key used to fall through to a bare billing page, highlighting
  // nothing. Now there is a public pricing page to send them back to.
  if (!v.planKey || !v.planExists) return { kind: "redirect", href: "/pricing" };

  if (v.planKey === FREE_PLAN_KEY) {
    return { kind: "redirect", href: `/register?plan=${encodeURIComponent(v.planKey)}` };
  }

  const isCustomer = v.tenantSlug !== null && !isDemoSlug(v.tenantSlug);
  if (isCustomer) {
    return {
      kind: "redirect",
      href: `/dashboard/settings/billing?plan=${encodeURIComponent(v.planKey)}`,
    };
  }

  return { kind: "enquire", planKey: v.planKey };
}
