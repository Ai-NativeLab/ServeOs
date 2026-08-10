import type { Localized } from "./types";

export type ChromeContent = {
  nav: { platform: string; trades: string; pricing: string; demo: string };
  signIn: string;
  getStarted: string;
  otherLocale: string;
  footer: {
    columns: { heading: string; links: { label: string; href: string }[] }[];
    trust: string[];
    copyright: string;
  };
};

export const CHROME: Localized<ChromeContent> = {
  ar: {
    nav: { platform: "المنصة", trades: "الأنشطة", pricing: "الأسعار", demo: "تجربة حية" },
    signIn: "تسجيل الدخول",
    getStarted: "ابدأ مجانًا",
    otherLocale: "English",
    footer: {
      columns: [
        { heading: "المنصة", links: [
          { label: "نقطة البيع", href: "#surfaces" },
          { label: "المتجر", href: "#surfaces" },
          { label: "واتساب", href: "#surfaces" },
          { label: "التقارير", href: "#features" },
        ]},
        { heading: "الأنشطة", links: [
          { label: "مطاعم", href: "#demo" },
          { label: "متاجر", href: "#demo" },
          { label: "صيدليات", href: "#demo" },
          { label: "أخشاب", href: "#demo" },
        ]},
        { heading: "الأسعار", links: [
          { label: "الباقات", href: "#pricing" },
          { label: "مدد الاشتراك", href: "#pricing" },
          { label: "الأسئلة الشائعة", href: "#faq" },
        ]},
        { heading: "الشركة", links: [
          { label: "من نحن", href: "#story" },
          { label: "ابدأ مجانًا", href: "/register" },
          { label: "تسجيل الدخول", href: "/login" },
        ]},
      ],
      trust: ["بالجنيه المصري", "دعم بالعربي", "بياناتك ملكك"],
      copyright: "© ٢٠٢٦ ServeOS",
    },
  },
  en: {
    nav: { platform: "Platform", trades: "Trades", pricing: "Pricing", demo: "Live demo" },
    signIn: "Sign in",
    getStarted: "Start free",
    otherLocale: "العربية",
    footer: {
      columns: [
        { heading: "Platform", links: [
          { label: "Point of sale", href: "#surfaces" },
          { label: "Storefront", href: "#surfaces" },
          { label: "WhatsApp", href: "#surfaces" },
          { label: "Reporting", href: "#features" },
        ]},
        { heading: "Trades", links: [
          { label: "Restaurants", href: "#demo" },
          { label: "Retail", href: "#demo" },
          { label: "Pharmacies", href: "#demo" },
          { label: "Timber", href: "#demo" },
        ]},
        { heading: "Pricing", links: [
          { label: "Plans", href: "#pricing" },
          { label: "Billing terms", href: "#pricing" },
          { label: "FAQ", href: "#faq" },
        ]},
        { heading: "Company", links: [
          { label: "About", href: "#story" },
          { label: "Start free", href: "/register" },
          { label: "Sign in", href: "/login" },
        ]},
      ],
      trust: ["Priced in EGP", "Arabic support", "Your data is yours"],
      copyright: "© 2026 ServeOS",
    },
  },
};
