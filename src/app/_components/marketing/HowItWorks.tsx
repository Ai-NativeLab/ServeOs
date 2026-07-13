"use client";
import { useLang } from "./LangProvider";
import { useVertical } from "./VerticalProvider";

export function MarketingHowItWorks() {
  const { t } = useLang();
  const { id, v, accent } = useVertical();

  return (
    <section id="how-it-works" className="border-t bg-secondary/40 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow" style={{ color: accent }}>
          {t.how.eyebrow}
        </p>
        <h2 className="font-display mt-2 text-3xl font-bold text-ink sm:text-4xl">{t.how.heading}</h2>

        <div key={id} className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3">
          {v.steps.map((s, i) => (
            <div key={s.title}>
              <div className="font-mono text-sm font-medium tabular-nums" style={{ color: accent }}>
                {String(i + 1).padStart(2, "0")}
              </div>
              <h3 className="font-display mt-2 text-lg font-bold text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
