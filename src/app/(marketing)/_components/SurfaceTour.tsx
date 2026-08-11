"use client";
import { SURFACE_KEYS, SURFACES } from "../_content/surfaces";
import { useTrade } from "./TradeProvider";
import { SurfaceBand } from "./SurfaceBand";
import { WhatsappBand } from "./WhatsappBand";

export function SurfaceTour() {
  const { locale } = useTrade();
  const t = SURFACES[locale];

  return (
    <section id="surfaces" className="mx-auto max-w-6xl px-6 py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      <div className="mt-6 divide-y divide-border/60">
        {SURFACE_KEYS.map((surface, i) => (
          <SurfaceBand key={surface} surface={surface} index={i} />
        ))}
        <WhatsappBand index={SURFACE_KEYS.length} />
      </div>
    </section>
  );
}
