"use client";
import { Languages } from "lucide-react";
import { useLang } from "./LangProvider";

export function LangToggle({ className }: { className?: string }) {
  const { locale, setLocale, t } = useLang();
  const next = locale === "en" ? "ar" : "en";
  const label = locale === "en" ? t.toggle.toArabic : t.toggle.toEnglish;

  return (
    <button
      type="button"
      onClick={() => setLocale(next)}
      aria-label={locale === "en" ? "التبديل إلى العربية" : "Switch to English"}
      className={
        "inline-flex items-center gap-1.5 rounded-full border border-sidebar-border px-3 py-1.5 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:text-sidebar-foreground " +
        (className ?? "")
      }
    >
      <Languages className="size-4" />
      {label}
    </button>
  );
}
