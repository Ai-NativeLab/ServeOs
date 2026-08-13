"use client";
import { SOON } from "../_content/trades";
import { useTrade } from "./TradeProvider";

const HEADING = {
  ar: { eyebrow: "ما الذي تحصل عليه", heading: "كل ما تحتاجه خلف المنضدة." },
  en: { eyebrow: "What you get", heading: "Everything you need behind the counter." },
} as const;

export function FeatureGrid() {
  const { trade, locale } = useTrade();
  const t = HEADING[locale];

  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <div data-trade-anim className="mt-10 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
        {trade.features.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.title}>
              <Icon aria-hidden="true" className="size-5" style={{ color: "var(--trade-accent)" }} />
              <h3 className="mt-3 flex items-center gap-2 text-base font-bold tracking-[-0.01em]">
                {f.title}
                {f.roadmap ? (
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-normal text-muted-foreground">
                    {SOON[locale]}
                  </span>
                ) : null}
              </h3>
              <p className="mt-2 text-sm leading-7 text-muted-foreground">{f.description}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
