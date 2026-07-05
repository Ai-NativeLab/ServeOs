"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { marketingDict, type Locale, type MarketingCopy } from "./i18n";

type LangContextValue = { locale: Locale; setLocale: (l: Locale) => void; t: MarketingCopy };

const LangContext = createContext<LangContextValue | null>(null);
const STORAGE_KEY = "serveos.marketing.locale";

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  // Hydrate the saved preference after mount (localStorage is client-only, so
  // the server always renders English; a returning Arabic visitor flips on mount).
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "ar" || saved === "en") setLocaleState(saved);
  }, []);

  // Reflect the locale on <html> so direction and language are correct for the
  // whole marketing page. Restore on unmount so navigating to other surfaces
  // (dashboard/storefront) isn't left in a stale direction.
  useEffect(() => {
    const el = document.documentElement;
    const prevDir = el.getAttribute("dir");
    const prevLang = el.getAttribute("lang");
    el.setAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    el.setAttribute("lang", locale);
    return () => {
      if (prevDir) el.setAttribute("dir", prevDir);
      else el.removeAttribute("dir");
      el.setAttribute("lang", prevLang ?? "en");
    };
  }, [locale]);

  function setLocale(l: Locale) {
    setLocaleState(l);
    window.localStorage.setItem(STORAGE_KEY, l);
  }

  return (
    <LangContext.Provider value={{ locale, setLocale, t: marketingDict[locale] }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useLang must be used within LangProvider");
  return ctx;
}
