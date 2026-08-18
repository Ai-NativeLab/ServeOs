import Link from "next/link";
import type { Plan } from "@/server/subscription";
import { pricingHref } from "@/marketing-locale";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../_content/pricing";
import { PricingTerms } from "./PricingTerms";

export function Pricing({ plans, locale }: { plans: Plan[]; locale: Locale }) {
  const t = PRICING[locale];

  return (
    <section id="pricing" className="mx-auto max-w-6xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
      <p className="mt-4 max-w-xl text-sm leading-7 text-muted-foreground">{t.note}</p>
      <PricingTerms plans={plans} locale={locale} />

      {/* The cards sell; the full limits and feature grid does not fit here.
          It lives on /pricing, which is also the link to send when someone
          asks for pricing. Locale-aware: Arabic owns the unprefixed /pricing,
          so a hardcoded "/pricing" sent English readers to the Arabic page. */}
      <Link
        href={pricingHref(locale)}
        className="mt-10 inline-block text-sm font-medium underline underline-offset-4 hover:no-underline"
      >
        {t.compareAll}
      </Link>
    </section>
  );
}
