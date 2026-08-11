const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E\")";

/**
 * The page's material. A flat hex reads as a filled div; grain over three warm
 * radial washes reads as lit paper. Both layers are decorative and inert.
 */
export function PaperSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative bg-background text-foreground">
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
      {/* Editorial furniture: a 120px hairline column grid, barely visible, that
          gives the page an underlying measure rather than free-floating blocks. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: "linear-gradient(to right, color-mix(in srgb, var(--foreground) 4.5%, transparent) 1px, transparent 1px)",
          backgroundSize: "120px 100%",
        }}
      />
      <div className="relative">{children}</div>
    </div>
  );
}
