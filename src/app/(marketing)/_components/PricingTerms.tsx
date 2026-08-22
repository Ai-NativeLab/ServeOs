"use client";
import { useState } from "react";
import type { Plan } from "@/server/subscription";
import type { Locale } from "@/shared/errors";
import { PRICING } from "../_content/pricing";
import { TERMS, type TermKey } from "../_lib/terms";
import { PlanCard } from "./PlanCard";

export function PricingTerms({ plans, locale }: { plans: Plan[]; locale: Locale }) {
  const [key, setKey] = useState<TermKey>("quarterly");
  const t = PRICING[locale];
  const term = TERMS.find((x) => x.key === key) ?? TERMS[0];
  const pct = new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en", { style: "percent" });

  return (
    <>
      <div role="tablist" aria-label={t.eyebrow} className="mt-8 inline-flex flex-wrap gap-2 rounded-full border border-border p-1">
        {TERMS.map((option) => {
          const selected = option.key === key;
          return (
            <button
              key={option.key}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setKey(option.key)}
              className={selected
                ? "rounded-full bg-foreground px-4 py-1.5 text-sm text-background"
                : "rounded-full px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground"}
            >
              {t.terms[option.key]}
              {option.discount > 0 ? (
                <span className="ms-2 text-[11px] opacity-80">{t.save} {pct.format(option.discount)}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => <PlanCard key={plan.id} plan={plan} term={term} locale={locale} />)}
      </div>
    </>
  );
}
