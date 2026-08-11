"use client";
import Image from "next/image";
import type { SurfaceKey } from "../_content/surfaces";
import { SURFACES } from "../_content/surfaces";
import { ordinal } from "../_lib/format";
import { CAPTURED_SURFACES, posShotPath, shotPath, type CapturedSurface } from "../_lib/shots";
import { useTrade } from "./TradeProvider";

function isCaptured(surface: SurfaceKey): surface is CapturedSurface {
  return (CAPTURED_SURFACES as readonly string[]).includes(surface);
}

export function SurfaceBand({ surface, index }: { surface: SurfaceKey; index: number }) {
  const { id, locale } = useTrade();
  const t = SURFACES[locale].bands[surface];
  const flip = index % 2 === 1;
  // POS is an Electron app, so its image is a hand-captured asset rather than
  // one of the automated per-trade captures.
  const src = isCaptured(surface) ? shotPath(id, surface) : posShotPath();

  return (
    // The copy column is deliberately narrow — a heading, two lines and a chip
    // cannot fill half a 1280px page, and trying to leaves a void. The
    // screenshot takes the remaining ~60% and is the section's visual weight.
    <div className="grid items-center gap-10 py-12 lg:grid-cols-[minmax(0,34%)_minmax(0,66%)] lg:gap-14 lg:py-0">
      <div className={flip ? "lg:order-2" : undefined}>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {ordinal(index, locale)}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em] lg:text-3xl">{t.title}</h3>
        <p className="mt-4 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>
        <p className="mt-5 inline-block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          {t.callout}
        </p>
      </div>

      <div className={flip ? "lg:order-1" : undefined}>
        {/* A fixed aspect ratio, not h-auto. next/image collapses to zero
            height when the file 404s, and every screenshot 404s until the
            capture pipeline runs — which is most of the dead space in this
            section. The frame now holds its footprint whatever the image does. */}
        <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-border bg-muted/40 shadow-[0_20px_50px_rgba(58,51,44,0.14)]">
          <Image src={src} alt={t.title} fill sizes="(min-width: 1024px) 62vw, 100vw" loading="lazy" className="object-cover object-top" />
        </div>
      </div>
    </div>
  );
}
