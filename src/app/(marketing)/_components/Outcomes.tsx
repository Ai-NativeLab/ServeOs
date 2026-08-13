import type { Locale } from "@/shared/errors";
import { OUTCOMES } from "../_content/outcomes";

export function Outcomes({ locale }: { locale: Locale }) {
  const t = OUTCOMES[locale];

  return (
    <section id="outcomes" className="mx-auto max-w-6xl px-6 py-20">
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
        {/* Stated plainly: these are scenarios, not customer quotes. */}
        <span className="rounded-full border border-border px-2.5 py-0.5 text-[10px] text-muted-foreground">{t.label}</span>
      </div>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <div className="mt-10 grid gap-8 sm:grid-cols-3">
        {t.items.map((item) => (
          <article key={item.scenario} className="rounded-xl border border-border bg-card/60 p-5">
            <h3 className="text-base font-bold tracking-[-0.01em]">{item.scenario}</h3>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">{item.situation}</p>
            <p className="mt-3 border-t border-border/60 pt-3 text-sm leading-7">{item.result}</p>
            {item.attribution ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {item.attribution.name} — {item.attribution.role}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
