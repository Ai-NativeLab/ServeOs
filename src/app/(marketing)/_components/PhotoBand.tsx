"use client";
import Image from "next/image";
import { useTrade } from "./TradeProvider";

/**
 * Duotone: a full-bleed photograph under an accent wash in multiply. The source
 * images are swappable assets — until real Egyptian photography is sourced the
 * band renders the accent field alone, which is a deliberate empty state rather
 * than a broken image.
 */
export function PhotoBand({ src }: { src?: string }) {
  const { trade } = useTrade();

  return (
    <section className="relative isolate my-8 h-[280px] overflow-hidden sm:h-[340px]">
      {src ? (
        <Image src={src} alt="" fill sizes="100vw" className="object-cover grayscale" />
      ) : null}
      <div
        aria-hidden="true"
        className="absolute inset-0 mix-blend-multiply"
        style={{ backgroundColor: "color-mix(in srgb, var(--trade-accent) 55%, transparent)" }}
      />
      <div className="relative flex h-full items-end">
        <p className="mx-auto w-full max-w-6xl px-6 pb-8 text-2xl font-bold tracking-[-0.02em] text-background">
          {trade.photoCaption}
        </p>
      </div>
    </section>
  );
}
