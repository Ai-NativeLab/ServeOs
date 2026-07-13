"use client";
import { useLang } from "./LangProvider";
import { useVertical } from "./VerticalProvider";

export function MarketingFeatures() {
  const { t } = useLang();
  const { id, v, accent, shared } = useVertical();

  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24">
      <div className="mb-12 max-w-2xl">
        <p className="eyebrow" style={{ color: accent }}>
          {t.features.eyebrow}
        </p>
        <h2 className="font-display mt-2 text-3xl font-bold text-ink sm:text-4xl">{t.features.heading}</h2>
      </div>

      <div key={id} className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
        {v.features.map((f) => {
          const Icon = f.icon;
          return (
            <div key={f.title} className="flex h-full flex-col rounded-xl border bg-card p-6">
              <div
                className="mb-4 grid size-12 place-items-center rounded-lg"
                style={{ backgroundColor: `${accent}1F`, color: accent }}
              >
                <Icon className="size-6" strokeWidth={1.75} />
              </div>
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-display text-lg font-bold text-ink">{f.title}</h3>
                {f.roadmap && (
                  <span className="mt-0.5 shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {shared.soon}
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{f.description}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
