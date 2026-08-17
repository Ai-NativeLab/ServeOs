"use client";
import { VERTICAL_IDS } from "@/server/verticals";
import { CHROME } from "../_content/chrome";
import { useTrade } from "./TradeProvider";

export function TradeSwitcher() {
  const { id, setTrade, all, locale } = useTrade();

  return (
    <div role="tablist" aria-label={CHROME[locale].a11y.tradeSwitcher} className="flex flex-wrap items-center gap-2">
      {VERTICAL_IDS.map((tradeId) => {
        const selected = tradeId === id;
        return (
          <button
            key={tradeId}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => setTrade(tradeId)}
            className={
              selected
                ? "rounded-full border px-4 py-1.5 text-sm transition-colors motion-reduce:transition-none"
                : "rounded-full border border-border px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground motion-reduce:transition-none"
            }
            style={
              selected
                ? {
                    borderColor: "color-mix(in srgb, var(--trade-accent) 45%, transparent)",
                    backgroundColor: "color-mix(in srgb, var(--trade-accent) 12%, transparent)",
                    color: "color-mix(in srgb, var(--trade-accent) 75%, black)",
                  }
                : undefined
            }
          >
            {all[tradeId].label}
          </button>
        );
      })}
    </div>
  );
}
