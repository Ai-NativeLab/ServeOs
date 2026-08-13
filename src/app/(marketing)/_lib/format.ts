import type { Locale } from "@/shared/errors";

/**
 * Money for the marketing page. Arabic gets Arabic-Indic digits, which is what
 * an Egyptian buyer reads on a receipt — src/lib/money.ts stays English-only
 * for the app surfaces and is deliberately not reused here.
 */
export function formatEgp(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-EG", {
    style: "currency",
    currency: "EGP",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Zero-padded section numerals — ٠١ ٠٢ ٠٣ in Arabic, 01 02 03 in English.
 * Part of the editorial furniture, and shared so the surface tour, the WhatsApp
 * band and the steps cannot drift into different numbering systems.
 */
export function ordinal(index: number, locale: Locale): string {
  const n = new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-US").format(index + 1);
  return n.padStart(2, locale === "ar" ? "٠" : "0");
}
