"use client";
import { useLang } from "./LangProvider";
import { useVertical } from "./VerticalProvider";
import { verticals, VERTICAL_IDS } from "./verticals";

/**
 * The four verticals share one grid track each, so the control keeps a fixed
 * footprint no matter how long the active label renders in en/ar.
 */
export function VerticalSwitcher() {
  const { locale } = useLang();
  const { id, setVertical } = useVertical();

  return (
    <div
      role="tablist"
      aria-label={locale === "ar" ? "اختر مجال عملك" : "Choose your trade"}
      className="grid w-full max-w-lg grid-cols-2 gap-1 rounded-2xl border border-white/12 bg-white/[0.04] p-1 sm:grid-cols-4 sm:rounded-full"
    >
      {VERTICAL_IDS.map((vid) => {
        const def = verticals[vid];
        const active = vid === id;
        return (
          <button
            key={vid}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => setVertical(vid)}
            style={active ? { backgroundColor: def.accent, color: "#14120F" } : undefined}
            className={[
              "rounded-xl px-3 py-2 text-center text-sm font-medium sm:rounded-full",
              "transition-colors duration-200 motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70",
              active ? "font-semibold" : "text-white/60 hover:bg-white/[0.07] hover:text-white/90",
            ].join(" ")}
          >
            {def.copy[locale].label}
          </button>
        );
      })}
    </div>
  );
}
