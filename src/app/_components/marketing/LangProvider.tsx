"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { marketingDict, type Locale, type MarketingCopy } from "./i18n";

type LangContextValue = { locale: Locale; setLocale: (l: Locale) => void; t: MarketingCopy };

const LangContext = createContext<LangContextValue | null>(null);
const STORAGE_KEY = "serveos.marketing.locale";

function readSavedLocale(): Locale | null {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "ar" || saved === "en" ? saved : null;
  } catch {
    return null;
  }
}

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("en");

  // Hydrate the saved preference after mount (localStorage is client-only, so
  // the server always renders English; a returning Arabic visitor flips on mount).
  useEffect(() => {
    const saved = readSavedLocale();
    if (saved) setLocaleState(saved);
  }, []);

  // Capture the page's original <html> dir/lang once and restore them when the
  // marketing page unmounts — App Router keeps <html> mounted across client
  // navigation, so a stale rtl/ar would otherwise leak into other surfaces.
  useEffect(() => {
    const el = document.documentElement;
    const prevDir = el.getAttribute("dir");
    const prevLang = el.getAttribute("lang");
    return () => {
      if (prevDir) el.setAttribute("dir", prevDir);
      else el.removeAttribute("dir");
      el.setAttribute("lang", prevLang ?? "en");
    };
  }, []);

  // Reflect the current locale on <html> so direction and language are correct
  // for the whole marketing page.
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    el.setAttribute("lang", locale);
  }, [locale]);

  function setLocale(l: Locale) {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Storage may be unavailable (private mode, disabled); the toggle still
      // works for this session, it just won't persist.
    }
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
