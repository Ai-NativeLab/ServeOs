"use client";
import { Check } from "lucide-react";
import type { SurfaceKey } from "../_content/surfaces";
import { SURFACES } from "../_content/surfaces";
import { ordinal } from "../_lib/format";
import {
  CAPTURED_SURFACES,
  SURFACE_DEVICE,
  isWindowed,
  posShotPath,
  shotPath,
  type CapturedSurface,
} from "../_lib/shots";
import { DeviceFrame } from "./DeviceFrame";
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
  const device = SURFACE_DEVICE[surface];

  // The column split follows the device, because a portrait phone and a 16:10
  // browser window want opposite proportions. Giving both the same 66% track
  // is what left a lake of empty space beside the narrow one.
  //
  // Phone bands size BOTH tracks intrinsically and centre the pair: a ~225px
  // portrait frame in a percentage track leaves dead air inside the track, and
  // a percentage copy track stretches four-word rows to 700px. Sizing to
  // content turns that dead air into an even outer margin instead.
  //
  // `order` moves a child between TRACKS, not just paint order, so the
  // template has to flip alongside it or every second band hands the
  // screenshot the wrong-sized track.
  const tracks = isWindowed(device)
    ? flip
      ? "lg:grid-cols-[minmax(0,62%)_minmax(0,38%)]"
      : "lg:grid-cols-[minmax(0,38%)_minmax(0,62%)]"
    : `lg:justify-center ${
        flip ? "lg:grid-cols-[auto_minmax(0,34rem)]" : "lg:grid-cols-[minmax(0,34rem)_auto]"
      }`;

  // Beside a phone the copy column is both wide AND short next to a ~500px
  // portrait frame, so the capabilities become full-width rows that give the
  // column real vertical extent. Beside a browser window the column is narrow
  // and the same rows simply stack tighter.
  const roomy = !isWindowed(device);

  return (
    <div className={`grid items-center gap-10 py-12 lg:gap-14 lg:py-0 ${tracks}`}>
      <div className={flip ? "lg:order-2" : undefined}>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {ordinal(index, locale)}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em] lg:text-3xl">{t.title}</h3>
        <p className="mt-4 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>

        {/* Concrete capabilities, not slogans — and rendered as bordered tiles
            rather than a bare list, so the copy column carries real visual
            weight instead of trailing off into the background. */}
        <ul className={`mt-6 grid grid-cols-1 ${roomy ? "gap-3" : "gap-2.5"}`}>
          {t.bullets.map((b) => (
            <li
              key={b}
              className={`flex items-start gap-3 rounded-xl border border-border/70 bg-card/60 text-sm leading-6 ${
                roomy ? "px-4 py-4" : "px-3.5 py-3"
              }`}
            >
              <Check
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
                style={{ color: "var(--trade-accent)" }}
              />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <p className="mt-6 inline-block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          {t.callout}
        </p>
      </div>

      <div className={flip ? "lg:order-1" : undefined}>
        <DeviceFrame device={device} src={src} alt={t.title} priority={index === 0} />
      </div>
    </div>
  );
}
