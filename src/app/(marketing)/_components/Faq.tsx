import type { Locale } from "@/shared/errors";
import { FAQ } from "../_content/faq";

export function Faq({ locale }: { locale: Locale }) {
  const t = FAQ[locale];

  return (
    <section id="faq" className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <dl className="mt-10 divide-y divide-border/60">
        {t.items.map((item) => (
          <div key={item.q} className="py-5">
            <dt className="text-base font-bold tracking-[-0.01em]">{item.q}</dt>
            <dd className="mt-2 text-sm leading-7 text-muted-foreground">{item.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
