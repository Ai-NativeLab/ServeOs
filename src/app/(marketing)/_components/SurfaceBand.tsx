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
  const src = isCaptured(surface) ? shotPath(id, surface, locale) : posShotPath(locale);

  return (
    <div className="grid items-center gap-10 py-12 lg:grid-cols-2 lg:gap-16">
      <div className={flip ? "lg:order-2" : undefined}>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {ordinal(index, locale)}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em]">{t.title}</h3>
        <p className="mt-3 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>
        <p className="mt-4 inline-block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">{t.callout}</p>
      </div>

      <div className={flip ? "lg:order-1" : undefined}>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_20px_50px_rgba(58,51,44,0.14)]">
          <Image
            src={src}
            alt={t.title}
            width={1440}
            height={900}
            loading="lazy"
            className="h-auto w-full"
          />
        </div>
      </div>
    </div>
  );
}
