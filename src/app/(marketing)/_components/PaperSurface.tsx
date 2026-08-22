import "./surface.css";

/**
 * The page's material.
 *
 * The background is not decoration — it says what ServeOS is. Channels — a
 * table's QR code, a WhatsApp chat, a storefront, a counter — arrive from both
 * edges of the page and land at one spine down the center, dashes travelling
 * along each so orders read as continuously landing rather than a single
 * static illustration.
 *
 * It is deliberately trade-neutral: this is the substrate of the company, not
 * of a dining room. The trade accent never tints the page background; it only
 * appears on elements doing a job.
 *
 * Motion lives in ./surface.css and is disabled wholesale under
 * prefers-reduced-motion. Only compositor properties and stroke-dashoffset are
 * animated — nothing here animates layout.
 */

const ink = (pct: number) => `color-mix(in srgb, var(--foreground) ${pct}%, transparent)`;

function ColumnGrid({ strength }: { strength: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        background: `linear-gradient(to right, ${ink(strength)} 1px, transparent 1px)`,
        backgroundSize: "120px 100%",
      }}
    />
  );
}

const DELAY = ["", "mk-d1", "mk-d2", "mk-d3", "mk-d4", "mk-d5"];

export function PaperSurface({ children }: { children: React.ReactNode }) {
  const lanes = Array.from({ length: 9 }, (_, i) => {
    const y = 60 + i * 95;
    return `M0 ${y} C 430 ${y}, 560 ${y + 120}, 600 900`;
  });
  const mirrored = lanes.map((d) =>
    d.replace(/^M0 /, "M1200 ").replaceAll(" 430 ", " 770 ").replaceAll(" 560 ", " 640 "),
  );
  const all = [...lanes, ...mirrored];

  return (
    <div className="relative bg-background text-foreground">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[820px] w-full"
        viewBox="0 0 1200 900"
        preserveAspectRatio="none"
        fill="none"
      >
        <g stroke={ink(5)} strokeWidth="1">
          {all.map((d) => <path key={d} d={d} />)}
        </g>
        <g stroke={ink(22)} strokeWidth="1.5" strokeLinecap="round">
          {all.map((d, i) => (
            <path key={d} d={d} className={`mk-flow ${DELAY[i % DELAY.length]}`} />
          ))}
        </g>
      </svg>
      <ColumnGrid strength={3} />
      <div className="relative">{children}</div>
    </div>
  );
}
