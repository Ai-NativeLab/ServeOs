"use client";
import { createContext, useContext, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { VERTICAL_ACCENTS, VERTICAL_IDS, type VerticalId } from "@/server/verticals";
import type { Locale } from "@/shared/errors";
import { TRADE_CONTENT, type TradeContent } from "../_content/trades";

type TradeContextValue = {
  id: VerticalId;
  setTrade: (id: VerticalId) => void;
  /** The active trade, resolved to the current locale. */
  trade: TradeContent;
  accent: string;
  locale: Locale;
  all: Record<VerticalId, TradeContent>;
};

const TradeContext = createContext<TradeContextValue | null>(null);

function isTrade(value: string | null): value is VerticalId {
  return value !== null && (VERTICAL_IDS as readonly string[]).includes(value);
}

/**
 * Content is imported here, NOT passed in as props.
 *
 * Trade content carries `LucideIcon` values, and lucide-react ships no
 * "use client" directive, so in the server graph those are plain functions.
 * Handing them from the server page to this client component throws
 * "Functions cannot be passed directly to Client Components" at render time —
 * and being a runtime error, tsc will not warn you.
 */
export function TradeProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const fromUrl = params.get("trade");
  const [id, setId] = useState<VerticalId>(isTrade(fromUrl) ? fromUrl : "restaurant");

  const all = useMemo(
    () =>
      Object.fromEntries(VERTICAL_IDS.map((t) => [t, TRADE_CONTENT[t][locale]])) as Record<
        VerticalId,
        TradeContent
      >,
    [locale],
  );

  function setTrade(next: VerticalId) {
    setId(next);
    // Mirrored to the URL so a link shared into a WhatsApp group opens on the
    // right trade. replace, not push — the back button should leave the page
    // rather than walk back through four trades. scroll:false keeps the reader
    // where they were.
    const q = new URLSearchParams(params.toString());
    q.set("trade", next);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }

  return (
    <TradeContext.Provider
      value={{ id, setTrade, trade: all[id], accent: VERTICAL_ACCENTS[id], locale, all }}
    >
      {/* Every section reads --trade-accent, so switching trade re-tints the
          page through CSS rather than re-rendering anything that doesn't care. */}
      <div style={{ ["--trade-accent" as string]: VERTICAL_ACCENTS[id] }} data-trade={id}>
        {children}
      </div>
    </TradeContext.Provider>
  );
}

export function useTrade(): TradeContextValue {
  const ctx = useContext(TradeContext);
  if (!ctx) throw new Error("useTrade must be used within TradeProvider");
  return ctx;
}
