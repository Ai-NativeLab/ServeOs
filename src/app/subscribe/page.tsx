import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { validateSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/server/auth/current-user";
import { listPlans } from "@/server/subscription";

/**
 * Where a paid plan's marketing CTA lands.
 *
 * The pricing page used to send every plan — free and paid alike — to
 * /register, which told a visitor choosing a 1099 EGP plan that the next step
 * was creating an account and then said nothing more about paying for it.
 *
 * This route exists because the marketing page is public and cannot know
 * whether the visitor is signed in, while the destination differs entirely:
 *
 *   signed in   -> the billing page, with the plan they picked highlighted
 *   signed out  -> login, carrying that same billing URL as `next`
 *
 * Putting that fork in a route rather than in PlanCard keeps the marketing
 * components free of auth concerns and gives the "I want to subscribe"
 * intent one place to live.
 *
 * NOTE: it deliberately does not create anything. Raising an invoice is an
 * explicit act the owner performs on the billing page, not a side effect of
 * following a link from a pricing table.
 */
export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string }>;
}) {
  const { plan } = await searchParams;

  // Validate against the real plan table rather than trusting the query
  // string — an unknown key would otherwise ride through login and land on
  // billing highlighting nothing.
  const plans = await listPlans();
  const match = plan ? plans.find((p) => p.key === plan) : undefined;

  const destination = match
    ? `/dashboard/settings/billing?plan=${encodeURIComponent(match.key)}`
    : "/dashboard/settings/billing";

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token ? await validateSession(token) : null;

  if (!session || !session.user.tenantId) {
    redirect(`/login?next=${encodeURIComponent(destination)}`);
  }

  redirect(destination);
}
