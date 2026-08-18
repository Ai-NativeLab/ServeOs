import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { listPlans } from "@/server/subscription";
import { getTenantById } from "@/server/tenancy/service";
import { isFreePrice } from "@/shared/plans";
import type { Locale } from "@/shared/errors";
import { subscribeDestination } from "./destination";
import { EnquiryForm } from "./EnquiryForm";

/**
 * Where a plan CTA lands, for every plan and every visitor.
 *
 * The marketing page is public and cannot know who is reading it, while the
 * right destination differs completely:
 *
 *   free plan       -> registration, carrying the key
 *   real customer   -> billing, with the plan highlighted
 *   demo visitor    -> the enquiry form
 *   signed out      -> the enquiry form
 *   unknown key     -> the pricing page
 *
 * The demo case is the one that used to be wrong. /api/demo/login issues a real
 * session, so "is signed in" was never the same question as "is a customer" —
 * and treating them as one delivered prospects into the demo tenant's billing
 * page, showing its usage meters and a Subscribe button that would have raised
 * an invoice against a tenant that is reset nightly.
 *
 * The rules live in subscribeDestination() so they are unit-testable; this file
 * only resolves who the visitor is and does what it says.
 *
 * NOTE: nothing here creates anything. Raising an invoice is an explicit act on
 * the billing page, never a side effect of following a link.
 */
export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; lang?: string }>;
}) {
  const { plan, lang } = await searchParams;

  // The locale rides in the URL because it cannot ride in a header: proxy.ts
  // deletes x-locale and only re-sets it for paths the marketing allowlist
  // rewrites. /subscribe is deliberately NOT one of them — that fallthrough is
  // what keeps /login and /register out of the marketing segment — so reading
  // x-locale here always yielded "en" and served an English-only form to the
  // default-locale visitor, on the one path this page exists to serve.
  //
  // A closed two-value set, validated the same way ?plan is: nothing to escape.
  const locale: Locale = lang === "en" ? "en" : "ar";

  const plans = await listPlans();
  const chosen = plan ? plans.find((p) => p.key === plan) : undefined;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;

  let tenantSlug: string | null = null;
  if (session?.user.tenantId) {
    const tenant = await getTenantById(session.user.tenantId);
    tenantSlug = tenant?.slug ?? null;
  }

  const destination = subscribeDestination({
    planKey: plan,
    planExists: Boolean(chosen),
    planIsFree: Boolean(chosen && isFreePrice(chosen.priceMonthly)),
    tenantSlug,
    locale,
  });
  if (destination.kind === "redirect") redirect(destination.href);

  return (
    <main>
      <EnquiryForm planKey={destination.planKey} locale={locale} />
    </main>
  );
}
