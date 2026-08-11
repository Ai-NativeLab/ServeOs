"use client";
import { Check } from "lucide-react";
import { SURFACES } from "../_content/surfaces";
import { ordinal } from "../_lib/format";
import { useTrade } from "./TradeProvider";

/**
 * Rendered from ServeOS tokens, never captured. Screenshotting WhatsApp would
 * reproduce Meta's interface, and dressing a mock up as a screenshot would
 * misrepresent whose product the visitor is looking at.
 */
export function WhatsappBand({ index }: { index: number }) {
  const { locale } = useTrade();
  const t = SURFACES[locale].whatsapp;

  return (
    <div className="grid items-center gap-10 py-12 lg:grid-cols-[minmax(0,34%)_minmax(0,66%)] lg:gap-14 lg:py-0">
      <div>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {ordinal(index, locale)}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em]">{t.title}</h3>
        <p className="mt-4 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>

        <ul className="mt-5 space-y-2.5">
          {t.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-sm leading-6">
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" style={{ color: "var(--trade-accent)" }} />
              <span>{b}</span>
            </li>
          ))}
        </ul>

        <p className="mt-6 inline-block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">{t.callout}</p>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-[0_20px_50px_rgba(58,51,44,0.14)]">
        <ul className="space-y-2.5">
          {t.chat.map((msg) => (
            <li
              key={msg.text}
              className={msg.from === "shop" ? "flex justify-end" : "flex justify-start"}
            >
              <span
                className="max-w-[80%] rounded-2xl px-3.5 py-2 text-[13px] leading-6"
                style={
                  msg.from === "shop"
                    ? { backgroundColor: "color-mix(in srgb, var(--trade-accent) 14%, transparent)" }
                    : { backgroundColor: "var(--muted)" }
                }
              >
                {msg.text}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
