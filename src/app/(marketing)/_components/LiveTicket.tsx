"use client";
import { useTrade } from "./TradeProvider";

export function LiveTicket() {
  const { trade, locale } = useTrade();
  const t = trade.ticket;

  return (
    <div
      data-testid="ticket"
      // Fixed min-height: the docket must not resize when the trade changes,
      // or the hero jumps on every switch. An E2E test pins this.
      className="min-h-[260px] w-full max-w-[280px] rounded-lg border border-border bg-card shadow-[0_18px_40px_rgba(58,51,44,0.20)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2"
      style={{ transform: "rotate(2.4deg)" }}
    >
      <div className="flex items-center justify-between border-b border-dashed border-border px-3.5 py-2.5">
        <span className="font-mono text-[11px] text-muted-foreground">{t.ref}</span>
        <span
          className="rounded-full px-2.5 py-0.5 text-[10px]"
          style={{
            backgroundColor: "color-mix(in srgb, var(--trade-accent) 14%, transparent)",
            color: "color-mix(in srgb, var(--trade-accent) 75%, black)",
          }}
        >
          {t.status}
        </span>
      </div>

      <div className="px-3.5 py-3 text-[13px] leading-7">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{t.channel}</p>
        {t.lines.map((line) => (
          <div key={`${line.name}-${line.meta}`} className="mb-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span>{line.qty} {line.name}</span>
              <span className="text-muted-foreground">{line.amount}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">{line.meta}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border bg-muted/50 px-3.5 py-2.5 text-sm font-bold">
        <span>{locale === "ar" ? "الإجمالي" : "Total"}</span>
        <span style={{ color: "var(--trade-accent)" }}>{t.total}</span>
      </div>
    </div>
  );
}
