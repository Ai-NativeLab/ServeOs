import type { PlanFeatures, PlanLimits } from "@/server/subscription";
import type { TermKey } from "../_lib/terms";
import type { Localized } from "./types";

export type PricingContent = {
  eyebrow: string;
  heading: string;
  note: string;
  terms: Record<TermKey, string>;
  save: string;
  perMonth: string;
  freePrice: string;
  cta: string;
  ctaFree: string;
  /** By plan key. Unknown keys fall back to plans.name — the plans spec owns the final key set. */
  planNames: Record<string, string>;
  limits: Record<keyof PlanLimits, string>;
  features: Record<keyof PlanFeatures, string>;
};

export const PRICING: Localized<PricingContent> = {
  ar: {
    eyebrow: "الأسعار",
    heading: "باقات بالجنيه المصري، من غير مفاجآت.",
    note: "أقل مدة اشتراك ثلاثة أشهر. الأسعار معروضة شهريًا وتُحتسب على المدة التي تختارها.",
    terms: { quarterly: "ربع سنوي", halfYearly: "نصف سنوي", annual: "سنوي" },
    save: "وفّر",
    perMonth: "شهريًا",
    freePrice: "مجاني",
    cta: "ابدأ الآن",
    ctaFree: "ابدأ مجانًا",
    planNames: { basic: "الأساسية", pro: "الاحترافية", enterprise: "المؤسسات" },
    limits: {
      branches: "فرع",
      staff: "مستخدم",
      products: "منتج",
      whatsapp_numbers: "رقم واتساب",
      orders_per_month: "طلب شهريًا",
      messages_per_month: "رسالة شهريًا",
    },
    features: {
      whatsapp: "الطلب من واتساب",
      custom_domain: "نطاق خاص",
      custom_theme: "تخصيص الهوية",
      reservations: "الحجوزات",
      advanced_analytics: "تقارير متقدمة",
      online_ordering: "الطلب الأونلاين",
    },
  },
  en: {
    eyebrow: "Pricing",
    heading: "Plans in Egyptian pounds, with no surprises.",
    note: "Three-month minimum term. Prices are shown monthly and billed over the term you choose.",
    terms: { quarterly: "Quarterly", halfYearly: "Half-yearly", annual: "Annual" },
    save: "Save",
    perMonth: "per month",
    freePrice: "Free",
    cta: "Get started",
    ctaFree: "Start free",
    planNames: { basic: "Basic", pro: "Pro", enterprise: "Enterprise" },
    limits: {
      branches: "branches",
      staff: "staff",
      products: "products",
      whatsapp_numbers: "WhatsApp numbers",
      orders_per_month: "orders / month",
      messages_per_month: "messages / month",
    },
    features: {
      whatsapp: "WhatsApp ordering",
      custom_domain: "Custom domain",
      custom_theme: "Custom branding",
      reservations: "Reservations",
      advanced_analytics: "Advanced reporting",
      online_ordering: "Online ordering",
    },
  },
};
