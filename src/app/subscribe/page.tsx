import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { listPlans } from "@/server/subscription";
import { getTenantById } from "@/server/tenancy/service";
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
  searchParams: Promise<{ plan?: string }>;
}) {
  const { plan } = await searchParams;

  const plans = await listPlans();
  const planExists = Boolean(plan && plans.some((p) => p.key === plan));

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;

  let tenantSlug: string | null = null;
  if (session?.user.tenantId) {
    const tenant = await getTenantById(session.user.tenantId);
    tenantSlug = tenant?.slug ?? null;
  }

  const destination = subscribeDestination({ planKey: plan, planExists, tenantSlug });
  if (destination.kind === "redirect") redirect(destination.href);

  const locale = (await headers()).get("x-locale") === "ar" ? "ar" : "en";
  return (
    <main>
      <EnquiryForm planKey={destination.planKey} locale={locale} />
    </main>
  );
}
