"use client";
import Link from "next/link";
import type { Plan } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { isFreePrice } from "@/shared/plans";
import { PRICING } from "../_content/pricing";
import { formatEgp } from "../_lib/format";
import { monthlyEquivalent, termTotal, type Term } from "../_lib/terms";

export function PlanCard({ plan, term, locale }: { plan: Plan; term: Term; locale: Locale }) {
  const t = PRICING[locale];
  const monthly = Number(plan.priceMonthly);
  const isFree = isFreePrice(plan.priceMonthly);
  const name = t.planNames[plan.key] ?? plan.name;

  // Zero-valued limits are not features. The seeded basic plan has
  // whatsapp_numbers: 0 and messages_per_month: 0 — listing those would sell
  // "0 WhatsApp numbers" as a benefit.
  const rows = [
    ...Object.entries(plan.limits)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${v} ${t.limits[k as keyof typeof t.limits]}`),
    ...Object.entries(plan.features)
      .filter(([, on]) => on)
      .map(([k]) => t.features[k as keyof typeof t.features]),
  ];

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card/60 p-6">
      <h3 className="text-base font-bold tracking-[-0.01em]">{name}</h3>

      <p className="mt-4 text-3xl font-extrabold tracking-[-0.03em]">
        {isFree ? t.freePrice : formatEgp(monthlyEquivalent(monthly, term.months, term.discount), locale)}
      </p>
      {!isFree ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t.perMonth} · {formatEgp(termTotal(monthly, term.months, term.discount), locale)} / {t.terms[term.key]}
        </p>
      ) : null}

      <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
        {rows.map((row) => <li key={row}>{row}</li>)}
      </ul>

      {/* Every plan goes through /subscribe, which owns the fork: free
          redirects to registration carrying its key, an existing customer goes
          to billing, and anyone else — signed out, or holding a demo session
          from the demo door on this very page — gets the enquiry form. Putting
          the branch in one route is why it can be unit-tested; when it lived
          here, "is signed in" was quietly treated as "is a customer" and
          prospects landed in the demo tenant's billing page.

          The locale rides along because /subscribe sits outside the marketing
          allowlist, so no x-locale header reaches it — without this the enquiry
          form renders in English for an Arabic reader. */}
      <Link
        href={`/subscribe?plan=${encodeURIComponent(plan.key)}&lang=${locale}`}
        className="mt-6 rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium hover:bg-muted"
      >
        {isFree ? t.ctaFree : t.cta}
      </Link>
    </div>
  );
}
