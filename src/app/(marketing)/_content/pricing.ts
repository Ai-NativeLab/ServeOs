import type { PlanFeatures, PlanLimits } from "@/server/subscription";
import type { TermKey } from "../_lib/terms";
import type { Localized } from "./types";
import type { FaqContent } from "./faq";

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
  /** Link from the home section through to the full comparison. */
  compareAll: string;
  /** The paid-plan enquiry form. Paid plans are sales-assisted, not self-serve. */
  enquiry: {
    heading: string;
    intro: string;
    name: string;
    businessName: string;
    phone: string;
    email: string;
    submit: string;
    success: string;
    tooSoon: string;
    failed: string;
  };
  faq: FaqContent;
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
    planNames: { basic: "المجانية", pro: "البداية", growth: "النمو", enterprise: "الاحترافية" },
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
    compareAll: "قارن كل الباقات",
    enquiry: {
      heading: "اطلب الباقة",
      intro: "سيبلنا بياناتك وهنتواصل معاك ونظبّطلك الحساب.",
      name: "الاسم",
      businessName: "اسم النشاط",
      phone: "رقم الموبايل",
      email: "البريد الإلكتروني",
      submit: "ابعت الطلب",
      success: "وصلنا طلبك. هنتواصل معاك قريب.",
      tooSoon: "استلمنا طلبك بالفعل. هنتواصل معاك قريب.",
      failed: "حصلت مشكلة. حاول تاني من فضلك.",
    },
    faq: {
      eyebrow: "أسئلة",
      heading: "أسئلة عن الباقات",
      items: [
        { q: "أقل مدة اشتراك كام؟", a: "ثلاثة شهور. الأسعار معروضة شهريًا وبتتحسب على المدة اللي تختارها." },
        { q: "أقدر أغيّر الباقة؟", a: "أيوه. كلّمنا وهننقلك للباقة الجديدة من غير ما تفقد أي بيانات." },
        { q: "لو عديت حد الباقة؟", a: "بنبلغك قبل ما توصل للحد، وبنتفق معاك على الترقية المناسبة." },
        { q: "الأسعار بالجنيه؟", a: "أيوه، كل الأسعار بالجنيه المصري." },
      ],
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
    planNames: { basic: "Free", pro: "Starter", growth: "Growth", enterprise: "Professional" },
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
    compareAll: "Compare all plans",
    enquiry: {
      heading: "Request this plan",
      intro: "Leave your details and we'll get in touch to set you up.",
      name: "Name",
      businessName: "Business name",
      phone: "Phone",
      email: "Email",
      submit: "Send request",
      success: "Got it. We'll be in touch shortly.",
      tooSoon: "We already have your request. We'll be in touch shortly.",
      failed: "Something went wrong. Please try again.",
    },
    faq: {
      eyebrow: "Questions",
      heading: "Questions about plans",
      items: [
        { q: "What is the minimum term?", a: "Three months. Prices are shown per month and billed over the term you choose." },
        { q: "Can I change plan later?", a: "Yes. Talk to us and we'll move you across without losing any data." },
        { q: "What if I exceed a limit?", a: "We tell you before you reach the limit and agree the right upgrade with you." },
        { q: "Are prices in Egyptian pounds?", a: "Yes, every price is in EGP." },
      ],
    },
  },
};
