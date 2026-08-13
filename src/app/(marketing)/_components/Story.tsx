import type { Locale } from "@/shared/errors";
import { STORY } from "../_content/story";

export function Story({ locale }: { locale: Locale }) {
  const t = STORY[locale];
  return (
    <section id="story" className="mx-auto max-w-3xl px-6 py-20">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
      {t.body.map((para) => (
        <p key={para.slice(0, 24)} className="mt-5 text-[15px] leading-8 text-muted-foreground">{para}</p>
      ))}
    </section>
  );
}
