import type { Locale } from "@/shared/errors";
import { VERTICAL_IDS } from "@/server/verticals";
import { DEMO } from "../_content/demo";
import { TRADE_CONTENT } from "../_content/trades";
import { DemoCard } from "./DemoCard";

export function DemoBand({ locale }: { locale: Locale }) {
  const t = DEMO[locale];

  return (
    <section id="demo" className="bg-[#14120F] text-[#F7F4F1]">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/50">{t.eyebrow}</p>
        <h2 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-[-0.03em]">{t.heading}</h2>
        <p className="mt-4 max-w-xl text-[15px] leading-8 text-white/70">{t.body}</p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {VERTICAL_IDS.map((trade) => (
            <DemoCard
              key={trade}
              trade={trade}
              label={TRADE_CONTENT[trade][locale].label}
              openStorefront={t.openStorefront}
              openDashboard={t.openDashboard}
            />
          ))}
        </div>

        <p className="mt-6 text-xs text-white/50">{t.resetNote}</p>
      </div>
    </section>
  );
}
