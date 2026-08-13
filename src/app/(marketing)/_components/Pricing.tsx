import type { Plan } from "@/server/subscription";
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
    </section>
  );
}
