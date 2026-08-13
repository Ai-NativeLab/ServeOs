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
    // A tinted, rounded panel rather than bare page. Competitors (SumUp, Zid,
    // Shopify) all put the product tour on a deliberate colour field, because
    // the space around a screenshot then reads as breathing room instead of
    // blank canvas — the cheapest fix for a section that looks empty.
    //
    // On desktop the section is exactly one viewport with its content
    // distributed through it, rather than min-h-screen letting short panels
    // float at the top with a void underneath.
    <section
      ref={scope}
      id="surfaces"
      // While pinned, this panel is the entire screen for ~3000px of scrolling,
      // so it has to FILL the viewport — a 685px panel in a 900px viewport
      // leaves empty bands above and below it for that whole stretch, which is
      // what "white space above and below" was.
      //
      // Filling the viewport is only half of it: the content must fill the
      // panel too, or the slack just moves inside. Hence flex column here and
      // a screenshot that grows into the space rather than a fixed aspect box.
      className="mx-auto flex max-w-6xl flex-col rounded-3xl bg-card/70 px-6 py-12 ring-1 ring-border/50 sm:px-10 lg:h-[calc(100vh-2rem)] lg:py-10"
    >
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
      {/* flex-1 + min-h-0 lets this claim the panel's remaining height instead
          of sitting at its natural size with slack underneath. min-h-0 is
          required or the grid refuses to shrink below its content. */}
      <div className="mt-6 divide-y divide-border/60 lg:mt-8 lg:grid lg:min-h-0 lg:flex-1 lg:divide-y-0 lg:[&>*]:col-start-1 lg:[&>*]:row-start-1">
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
