"use client";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { HEADLINE_HIGHLIGHT } from "../_content/trades";
import { shotPath } from "../_lib/shots";
import { useHeroTimeline } from "../_motion/useHeroTimeline";
import { Magnetic } from "../_motion/Magnetic";
import { useTrade } from "./TradeProvider";
import { LiveTicket } from "./LiveTicket";

const TRUST = {
  ar: ["بدون بطاقة ائتمان", "بالجنيه المصري", "عربي وإنجليزي"],
  en: ["No credit card", "Priced in EGP", "Arabic and English"],
} as const;

const CTA = {
  ar: { start: "ابدأ مجانًا", demo: "شاهد تجربة حية" },
  en: { start: "Start free", demo: "See a live demo" },
} as const;

export function Hero() {
  const { id, trade, locale } = useTrade();
  // Re-runs when the trade or language changes, so the headline re-splits and
  // the opening timeline replays against the new copy.
  const scope = useHeroTimeline([id, locale]);

  return (
    <section
      ref={scope}
      id="hero"
      className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:py-28"
    >
      <div>
        <p
          data-hero="eyebrow"
          className="mb-5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground"
        >
          <span
            data-hero="eyebrow-tick"
            aria-hidden="true"
            className="inline-block h-px w-6"
            style={{ backgroundColor: "var(--trade-accent)" }}
          />
          {trade.badge}
        </p>

        <h1
          key={`${id}-${locale}`}
          data-hero="headline"
          className="text-4xl font-extrabold leading-[1.18] tracking-[-0.035em] sm:text-5xl"
        >
          {trade.headlineLead}
          <br />
          {/* A marker swipe rather than coloured text — warmer, and being a
              background it needs no direction handling when the page flips. */}
          <span className="relative inline-block">
            <span className="relative z-10">{HEADLINE_HIGHLIGHT[locale]}</span>
            <span
              data-hero="marker"
              aria-hidden="true"
              className="absolute inset-x-0 bottom-1 z-0 h-3 rounded-sm"
              style={{ backgroundColor: "color-mix(in srgb, var(--trade-accent) 30%, transparent)" }}
            />
          </span>
        </h1>

        <p data-hero="subhead" className="mt-5 max-w-xl text-[15px] leading-8 text-muted-foreground">
          {trade.subhead}
        </p>

        <div data-hero="cta" className="mt-7 flex flex-wrap gap-3">
          <Magnetic>
            <Button asChild size="lg">
              <Link href="/register">{CTA[locale].start}</Link>
            </Button>
          </Magnetic>
          <Magnetic>
            <Button asChild size="lg" variant="outline">
              <Link href="#demo">{CTA[locale].demo}</Link>
            </Button>
          </Magnetic>
        </div>

        <ul data-hero="trust" className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {TRUST[locale].map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div data-hero="stack" className="relative min-h-[300px]">
        <div
          data-hero="shot"
          className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_26px_60px_rgba(58,51,44,0.16)]"
          style={{ transform: "rotate(-1.2deg)" }}
        >
          <Image
            src={shotPath(id, "dashboard")}
            alt=""
            width={1440}
            height={900}
            priority
            className="h-auto w-full"
          />
        </div>
        <div data-hero="ticket" className="absolute -bottom-6 end-0">
          <LiveTicket />
        </div>
      </div>
    </section>
  );
}
