"use client";
import { useLang } from "./LangProvider";

export function MarketingHowItWorks() {
  const { t } = useLang();
  return (
    <section id="how-it-works" className="border-t bg-secondary/40 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow text-primary">{t.how.eyebrow}</p>
        <h2 className="mt-2 font-display text-3xl font-bold text-ink sm:text-4xl">
          {t.how.heading}
        </h2>

        <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
          {t.how.steps.map((s, i) => (
            <div key={i}>
              <div className="font-mono text-sm font-medium text-primary">{String(i + 1).padStart(2, "0")}</div>
              <h3 className="mt-2 font-display text-lg font-bold text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
