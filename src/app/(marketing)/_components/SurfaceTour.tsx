"use client";
import { SURFACE_KEYS, SURFACES } from "../_content/surfaces";
import { usePinnedTour } from "../_motion/usePinnedTour";
import { useTrade } from "./TradeProvider";
import { SurfaceBand } from "./SurfaceBand";
import { WhatsappBand } from "./WhatsappBand";

export function SurfaceTour() {
  const { locale, id } = useTrade();
  const t = SURFACES[locale];
  const panelCount = SURFACE_KEYS.length + 1; // the three surfaces plus WhatsApp

  // Pins and cross-fades on desktop; a plain stacked list everywhere else.
  const scope = usePinnedTour(panelCount, [locale, id]);

  const labels = [...SURFACE_KEYS.map((s) => t.bands[s].title), t.whatsapp.title];

  return (
    <section ref={scope} id="surfaces" className="mx-auto max-w-6xl px-6 py-16 lg:min-h-screen lg:py-24">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{t.eyebrow}</p>
      <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>

      {/* Progress rail — which surface you're on, and how many are left. Hidden
          below the pin breakpoint, where the panels simply stack. */}
      <ul className="mt-8 hidden gap-6 lg:flex" aria-hidden="true">
        {labels.map((label) => (
          <li key={label} className="flex-1">
            <span className="block h-px w-full bg-border" />
            <span
              data-tour="marker"
              className="-mt-px block h-px w-full"
              style={{ backgroundColor: "var(--trade-accent)" }}
            />
            <span className="mt-2 block font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {label}
            </span>
          </li>
        ))}
      </ul>

      {/* On desktop the panels are stacked in one grid cell and cross-faded; on
          mobile they fall back to a normal divided list. */}
      <div className="mt-6 divide-y divide-border/60 lg:mt-10 lg:grid lg:divide-y-0 lg:[&>*]:col-start-1 lg:[&>*]:row-start-1">
        {SURFACE_KEYS.map((surface, i) => (
          <div key={surface} data-tour="panel">
            <SurfaceBand surface={surface} index={i} />
          </div>
        ))}
        <div data-tour="panel">
          <WhatsappBand index={SURFACE_KEYS.length} />
        </div>
      </div>
    </section>
  );
}
