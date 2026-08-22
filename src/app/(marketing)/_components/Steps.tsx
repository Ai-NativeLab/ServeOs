"use client";
import { ordinal } from "../_lib/format";
import { useTrade } from "./TradeProvider";

const HEADING = {
  ar: { eyebrow: "كيف تعمل", heading: "انطلق في ثلاث خطوات." },
  en: { eyebrow: "How it works", heading: "Live in three steps." },
} as const;

export function Steps() {
  const { trade, locale } = useTrade();
  const t = HEADING[locale];

  return (
    <section id="how-it-works" className="mx-auto max-w-6xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <ol data-trade-anim className="mt-10 grid gap-10 sm:grid-cols-3">
        {trade.steps.map((step, i) => (
          <li key={step.title} className={i > 0 ? "border-border/60 sm:border-s sm:ps-8" : undefined}>
            <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
              {ordinal(i, locale)}
            </p>
            <h3 className="mt-3 text-base font-bold tracking-[-0.01em]">{step.title}</h3>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
