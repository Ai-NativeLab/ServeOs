"use client";
import { useLayoutEffect } from "react";
import type { Locale } from "@/shared/errors";

/**
 * Keeps `<html lang dir>` in step with the `[lang]` segment.
 *
 * The root layout already sets both from the `x-locale` header, which is right
 * for a hard load — the correct direction ships in the first byte, no flip. But
 * the root layout sits ABOVE this segment, and Next preserves layouts above the
 * one that changed, so a client-side navigation between `/` and `/en` re-renders
 * the page and never re-renders `<html>`. The copy switched language while the
 * document stayed RTL.
 *
 * A layout effect rather than an effect: this runs before paint, so the switch
 * does not show a frame of English text in right-to-left.
 */
export function HtmlLocale({ locale }: { locale: Locale }) {
  useLayoutEffect(() => {
    const el = document.documentElement;
    el.setAttribute("lang", locale);
    el.setAttribute("dir", locale === "ar" ? "rtl" : "ltr");
  }, [locale]);

  return null;
}
