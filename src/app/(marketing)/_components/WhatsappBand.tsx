"use client";
import { Check } from "lucide-react";
import { SURFACES } from "../_content/surfaces";
import { ordinal } from "../_lib/format";
import { PhoneShell } from "./DeviceFrame";
import { useTrade } from "./TradeProvider";

/**
 * Rendered from ServeOS tokens, never captured. Screenshotting WhatsApp would
 * reproduce Meta's interface, and dressing a mock up as a screenshot would
 * misrepresent whose product the visitor is looking at.
 *
 * The phone bezel is the same neutral shell the storefront band uses, and the
 * bubbles are drawn in ServeOS's own accent rather than WhatsApp's green — so
 * it reads as "ordering happens on a phone", not as a capture of someone
 * else's app.
 */
export function WhatsappBand({ index }: { index: number }) {
  const { locale } = useTrade();
  const t = SURFACES[locale].whatsapp;
  const flip = index % 2 === 1;

  return (
    <div
      className={`grid items-center gap-10 py-12 lg:justify-center lg:gap-14 lg:py-0 ${
        flip ? "lg:grid-cols-[auto_minmax(0,34rem)]" : "lg:grid-cols-[minmax(0,34rem)_auto]"
      }`}
    >
      <div className={flip ? "lg:order-2" : undefined}>
        <p className="font-mono text-[11px] tracking-[0.2em]" style={{ color: "var(--trade-accent)" }}>
          {ordinal(index, locale)}
        </p>
        <h3 className="mt-3 text-2xl font-bold tracking-[-0.02em] lg:text-3xl">{t.title}</h3>
        <p className="mt-4 max-w-md text-[15px] leading-8 text-muted-foreground">{t.body}</p>

        <ul className="mt-6 grid grid-cols-1 gap-3">
          {t.bullets.map((b) => (
            <li
              key={b}
              className="flex items-start gap-3 rounded-xl border border-border/70 bg-card/60 px-4 py-4 text-sm leading-6"
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
        <PhoneShell>
          {/* Conversation chrome — a header and a composer — so the frame reads
              as a phone mid-chat. Without them the bubbles sat against the
              bottom edge and the top half of the handset was blank. */}
          <div className="flex size-full flex-col bg-card">
            <div className="flex items-center gap-2.5 border-b border-border/70 px-3.5 py-3">
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-full text-xs font-bold text-white"
                style={{ backgroundColor: "var(--trade-accent)" }}
              >
                {t.contact.slice(0, 1)}
              </span>
              <span className="truncate text-[13px] font-semibold">{t.contact}</span>
            </div>

            <div className="flex flex-1 flex-col justify-end gap-2.5 overflow-hidden p-3.5">
              {t.chat.map((msg) => (
                <div
                  key={msg.text}
                  className={msg.from === "shop" ? "flex justify-end" : "flex justify-start"}
                >
                  <span
                    className="max-w-[82%] rounded-2xl px-3.5 py-2 text-[13px] leading-6"
                    style={
                      msg.from === "shop"
                        ? { backgroundColor: "color-mix(in srgb, var(--trade-accent) 16%, transparent)" }
                        : { backgroundColor: "var(--muted)" }
                    }
                  >
                    {msg.text}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2 border-t border-border/70 px-3.5 py-3">
              <span className="flex-1 truncate rounded-full bg-muted px-3 py-1.5 text-[12px] text-muted-foreground">
                {t.composer}
              </span>
              <span
                aria-hidden="true"
                className="size-7 shrink-0 rounded-full"
                style={{ backgroundColor: "var(--trade-accent)" }}
              />
            </div>
          </div>
        </PhoneShell>
      </div>
    </div>
  );
}
