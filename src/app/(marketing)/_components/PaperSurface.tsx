import "./surface.css";

/**
 * The page's material.
 *
 * The background is not decoration — it says what ServeOS is. Every variant is
 * trade-neutral on purpose: this is the substrate of the company, not of a
 * dining room. All are neutral-toned; the trade accent never tints the page
 * itself, only elements doing a job.
 *
 * Motion lives in ./surface.css and is disabled wholesale under
 * prefers-reduced-motion. Only compositor properties and stroke-dashoffset are
 * animated — nothing here animates layout.
 *
 * TEMPORARY: `variant` exists so treatments can be compared live via
 * `?surface=`. Once one is chosen the rest go and this collapses to one.
 */
export type SurfaceVariant =
  | "converge"
  | "flow"
  | "mesh"
  | "orbit"
  | "weave"
  | "grid"
  | "ledger"
  | "clean"
  | "legacy";

export const SURFACE_VARIANTS: SurfaceVariant[] = [
  "converge", "flow", "mesh", "orbit", "weave", "grid", "ledger", "clean", "legacy",
];

export function isSurfaceVariant(value: string | undefined): value is SurfaceVariant {
  return value !== undefined && (SURFACE_VARIANTS as string[]).includes(value);
}

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E\")";

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

function Shell({ children, layers }: { children: React.ReactNode; layers: React.ReactNode }) {
  return (
    <div className="relative bg-background text-foreground">
      {layers}
      <div className="relative">{children}</div>
    </div>
  );
}

/** Channels entering from both edges and meeting at one spine. Symmetric, so it
 *  reads identically in RTL. */
const CHANNELS = [
  "M0 90 C 380 90, 480 300, 600 900",
  "M1200 90 C 820 90, 720 300, 600 900",
  "M0 260 C 420 260, 520 420, 600 900",
  "M1200 260 C 780 260, 680 420, 600 900",
  "M0 440 C 460 440, 545 560, 600 900",
  "M1200 440 C 740 440, 655 560, 600 900",
];

const DELAY = ["", "mk-d1", "mk-d2", "mk-d3", "mk-d4", "mk-d5"];

export function PaperSurface({
  children,
  variant = "converge",
}: {
  children: React.ReactNode;
  variant?: SurfaceVariant;
}) {
  // converge — the original curves, now alive: a dashed pulse travels down each
  // channel into the spine, and the spine breathes. The product's claim drawn
  // and then animated: four channels, one system, orders arriving continuously.
  if (variant === "converge") {
    return (
      <Shell
        layers={
          <>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-[900px] w-full"
              viewBox="0 0 1200 900"
              preserveAspectRatio="none"
              fill="none"
            >
              <g stroke={ink(7)} strokeWidth="1">
                {CHANNELS.map((d) => <path key={d} d={d} />)}
              </g>
              <g stroke={ink(26)} strokeWidth="1.5" strokeLinecap="round">
                {CHANNELS.map((d, i) => (
                  <path key={d} d={d} className={`mk-flow ${DELAY[i]}`} />
                ))}
              </g>
              <line
                x1="600" y1="0" x2="600" y2="900"
                stroke={ink(10)} strokeWidth="1" className="mk-breathe"
              />
            </svg>
            <ColumnGrid strength={3} />
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // flow — converge turned up: more channels, steeper, arriving faster. The same
  // idea read as throughput rather than architecture.
  if (variant === "flow") {
    const lanes = Array.from({ length: 9 }, (_, i) => {
      const y = 60 + i * 95;
      return `M0 ${y} C 430 ${y}, 560 ${y + 120}, 600 900`;
    });
    const mirrored = lanes.map((d) => d.replace(/^M0 /, "M1200 ").replaceAll(" 430 ", " 770 ").replaceAll(" 560 ", " 640 "));
    const all = [...lanes, ...mirrored];
    return (
      <Shell
        layers={
          <>
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
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // mesh — a lattice of counters. Nodes wake in sequence and the links between
  // them stay constant: many shops, one network, always something happening.
  if (variant === "mesh") {
    const cols = 13;
    const rows = 7;
    const nodes = Array.from({ length: cols * rows }, (_, i) => ({
      x: (i % cols) * 100 + 50,
      y: Math.floor(i / cols) * 130 + 60,
      i,
    }));
    return (
      <Shell
        layers={
          <>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 1300 910"
              preserveAspectRatio="xMidYMin slice"
              fill="none"
            >
              <g stroke={ink(5)} strokeWidth="1">
                {nodes.map((n) =>
                  n.x < 1250 ? <line key={`h${n.i}`} x1={n.x} y1={n.y} x2={n.x + 100} y2={n.y} /> : null,
                )}
                {nodes.map((n) =>
                  n.y < 850 ? <line key={`v${n.i}`} x1={n.x} y1={n.y} x2={n.x} y2={n.y + 130} /> : null,
                )}
              </g>
              <g fill={ink(30)}>
                {nodes
                  .filter((n) => n.i % 5 === 0)
                  .map((n) => (
                    <circle
                      key={`n${n.i}`}
                      cx={n.x}
                      cy={n.y}
                      r="2"
                      className={`mk-pulse ${DELAY[n.i % DELAY.length]}`}
                    />
                  ))}
              </g>
            </svg>
            <ColumnGrid strength={3} />
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // orbit — rings leaving a single core and fading outward. One system at the
  // centre, its reach expanding. The calmest of the animated set.
  if (variant === "orbit") {
    return (
      <Shell
        layers={
          <>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-[1000px] w-full"
              viewBox="0 0 1200 1000"
              preserveAspectRatio="xMidYMin slice"
              fill="none"
            >
              <g stroke={ink(16)} strokeWidth="1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <circle
                    key={i}
                    cx="600"
                    cy="150"
                    r="420"
                    className={`mk-ring ${DELAY[i]}`}
                  />
                ))}
              </g>
              <circle cx="600" cy="150" r="3" fill={ink(35)} className="mk-breathe" />
            </svg>
            <ColumnGrid strength={3.5} />
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // weave — two diagonal lattices crossing and drifting against each other.
  // Structure without a focal point: the fabric a system is built from.
  if (variant === "weave") {
    return (
      <Shell
        layers={
          <>
            <div
              aria-hidden="true"
              className="mk-drift pointer-events-none absolute inset-0"
              style={{
                background: [
                  `repeating-linear-gradient(45deg, ${ink(4.5)} 0 1px, transparent 1px 48px)`,
                  `repeating-linear-gradient(-45deg, ${ink(3.5)} 0 1px, transparent 1px 48px)`,
                ].join(","),
              }}
            />
            <ColumnGrid strength={3} />
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // grid — graph-paper dots on a column measure. Infrastructure built to a
  // tolerance. Static by design; the schematic reading wants stillness.
  if (variant === "grid") {
    return (
      <Shell
        layers={
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background: `radial-gradient(circle at center, ${ink(9)} 1px, transparent 1px)`,
                backgroundSize: "24px 24px",
              }}
            />
            <ColumnGrid strength={4} />
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // ledger — the ruling of an accounts book. ServeOS as system of record.
  if (variant === "ledger") {
    return (
      <Shell
        layers={
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background: `repeating-linear-gradient(to bottom, transparent 0 31px, ${ink(3.5)} 31px 32px)`,
              }}
            />
            <ColumnGrid strength={5} />
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // legacy — grain over accent-tinted washes. Kept for comparison only.
  if (variant === "legacy") {
    return (
      <Shell
        layers={
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background: [
                  "radial-gradient(900px 420px at 88% -12%, color-mix(in srgb, var(--trade-accent) 16%, transparent), transparent 62%)",
                  "radial-gradient(700px 340px at 6% 34%, color-mix(in srgb, var(--trade-accent) 10%, transparent), transparent 64%)",
                  "radial-gradient(600px 500px at 50% 108%, color-mix(in srgb, var(--trade-accent) 8%, transparent), transparent 60%)",
                ].join(","),
              }}
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-[0.22] mix-blend-multiply"
              style={{ backgroundImage: GRAIN }}
            />
            <ColumnGrid strength={4.5} />
          </>
        }
      >
        {children}
      </Shell>
    );
  }

  // clean — flat paper, hairline measure only. The control.
  return <Shell layers={<ColumnGrid strength={4} />}>{children}</Shell>;
}
