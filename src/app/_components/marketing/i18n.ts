import type { Locale } from "@/shared/errors";

export type { Locale };

/**
 * Chrome only. Everything that differs by trade — headlines, badges, features,
 * steps, the hero docket — lives in verticals.ts.
 */
export type MarketingCopy = {
  header: { features: string; howItWorks: string; signIn: string; getStarted: string };
  hero: { getStarted: string; signIn: string; trustNoLockIn: string; trustLanguages: string };
  features: { eyebrow: string; heading: string };
  how: { eyebrow: string; heading: string };
  cta: { getStarted: string };
  footer: { copyright: string };
  toggle: { toArabic: string; toEnglish: string; ariaToArabic: string; ariaToEnglish: string };
};

const en: MarketingCopy = {
  header: { features: "Features", howItWorks: "How it works", signIn: "Sign in", getStarted: "Get Started" },
  hero: {
    getStarted: "Get Started",
    signIn: "Sign in",
    trustNoLockIn: "No hardware lock-in",
    trustLanguages: "English, Spanish, Arabic",
  },
  features: { eyebrow: "What you get", heading: "Everything you need behind the counter." },
  how: { eyebrow: "How it works", heading: "Live in three steps." },
  cta: { getStarted: "Get Started" },
  footer: { copyright: "© 2026 ServeOS" },
  toggle: {
    toArabic: "العربية",
    toEnglish: "English",
    ariaToArabic: "التبديل إلى العربية",
    ariaToEnglish: "Switch to English",
  },
};

const ar: MarketingCopy = {
  header: { features: "المميزات", howItWorks: "كيف تعمل", signIn: "تسجيل الدخول", getStarted: "ابدأ الآن" },
  hero: {
    getStarted: "ابدأ الآن",
    signIn: "تسجيل الدخول",
    trustNoLockIn: "دون التقيد بأجهزة معينة",
    trustLanguages: "الإنجليزية والإسبانية والعربية",
  },
  features: { eyebrow: "ما الذي تحصل عليه", heading: "كل ما تحتاجه خلف الكاونتر." },
  how: { eyebrow: "كيف تعمل", heading: "انطلق في ثلاث خطوات." },
  cta: { getStarted: "ابدأ الآن" },
  footer: { copyright: "© 2026 ServeOS" },
  toggle: {
    toArabic: "العربية",
    toEnglish: "English",
    ariaToArabic: "التبديل إلى العربية",
    ariaToEnglish: "Switch to English",
  },
};

export const marketingDict: Record<Locale, MarketingCopy> = { en, ar };
