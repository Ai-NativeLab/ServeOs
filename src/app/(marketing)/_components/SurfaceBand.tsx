"use client";
import { Check } from "lucide-react";
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
    // The track widths flip with the row. `order` changes which TRACK each
    // child is placed into, not just where it paints — so with a fixed
    // 34%/66% template every alternating band handed the screenshot the narrow
    // track and the copy the wide one. The template flips with the order.
    <div
      className={`grid items-center gap-10 py-12 lg:h-full lg:gap-14 lg:py-0 ${
        flip
          ? "lg:grid-cols-[minmax(0,66%)_minmax(0,34%)]"
          : "lg:grid-cols-[minmax(0,34%)_minmax(0,66%)]"
      }`}
    >
      <div className={flip ? "lg:order-2" : undefined}>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {ordinal(index, locale)}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em] lg:text-3xl">{t.title}</h3>
        <p className="mt-4 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>

        {/* Concrete capabilities, not slogans. A heading and one sentence beside
            a tall screenshot leaves a void; three checked bullets give the column
            real vertical content. */}
        <ul className="mt-5 space-y-2.5">
          {t.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-sm leading-6">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" style={{ color: "var(--trade-accent)" }} />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <p className="mt-6 inline-block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          {t.callout}
        </p>
      </div>

      {/* lg:h-full is load-bearing: the frame inside uses h-full, and h-full
          against an auto-height parent collapses to zero — which silently
          removes the screenshot and leaves an empty column. */}
      <div className={flip ? "lg:order-1 lg:h-full" : "lg:h-full"}>
        {/* A fixed aspect ratio, not h-auto. next/image collapses to zero
            height when the file 404s, and every screenshot 404s until the
            capture pipeline runs — which is most of the dead space in this
            section. The frame now holds its footprint whatever the image does. */}
        {/* Aspect ratio below lg where the panels simply stack; on desktop the
            frame fills the pinned panel's height instead, so the slack does not
            reappear inside the box we just grew. */}
        <div className="relative aspect-[16/10] overflow-hidden rounded-xl border border-border bg-muted/40 shadow-[0_20px_50px_rgba(58,51,44,0.14)] lg:aspect-auto lg:h-full">
          <Image src={src} alt={t.title} fill sizes="(min-width: 1024px) 62vw, 100vw" loading="lazy" className="object-cover object-top" />
        </div>
      </div>
    </div>
  );
}
