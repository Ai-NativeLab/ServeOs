import { pricingHref } from "@/marketing-locale";
import { isDemoSlug } from "@/server/demo/entry";
import type { Locale } from "@/shared/errors";

export type SubscribeVisitor = {
  planKey: string | undefined;
  /** Whether planKey matched a row in the plans table. Never trust the query string. */
  planExists: boolean;
  /**
   * Whether that row costs nothing, read off the same price column PlanCard
   * renders from. A boolean rather than a key comparison so the card's "Start
   * free" label and this fork can never disagree — see isFreePrice.
   */
  planIsFree: boolean;
  /** The signed-in tenant's slug, or null when signed out or without a tenant. */
  tenantSlug: string | null;
  /** Which language the visitor is reading, so redirects stay in it. */
  locale: Locale;
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
  // nothing. Now there is a public pricing page to send them back to — in the
  // language they were reading, since Arabic owns the unprefixed /pricing.
  if (!v.planKey || !v.planExists) return { kind: "redirect", href: pricingHref(v.locale) };

  // The free plan self-serves: there is nothing to sell and nothing to invoice.
  if (v.planIsFree) {
    return { kind: "redirect", href: `/register?plan=${encodeURIComponent(v.planKey)}` };
  }

  // Tenant STATUS is deliberately not consulted. A suspended or past-due tenant
  // is still a customer, and billing is exactly where they need to land to fix
  // it — sending them to a sales enquiry form instead would be absurd. Only the
  // demo/real distinction matters here.
  const isCustomer = v.tenantSlug !== null && !isDemoSlug(v.tenantSlug);
  if (isCustomer) {
    return {
      kind: "redirect",
      href: `/dashboard/settings/billing?plan=${encodeURIComponent(v.planKey)}`,
    };
  }

  return { kind: "enquire", planKey: v.planKey };
}
