"use client";
import { useTrade } from "./TradeProvider";
import { TradeSwitcher } from "./TradeSwitcher";

const LABEL = { ar: "اختر نشاطك", en: "Choose your trade" } as const;
const NOTE = { ar: "اللون والمحتوى بيتغيروا مع النشاط", en: "Colour and copy follow the trade" } as const;

export function TradeBand() {
  const { locale } = useTrade();
  return (
    <section className="border-y border-border/60 bg-card/50">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-6 py-4">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{LABEL[locale]}</span>
        <TradeSwitcher />
        <span className="ms-auto hidden text-[11px] text-muted-foreground lg:inline">{NOTE[locale]}</span>
      </div>
    </section>
  );
}
