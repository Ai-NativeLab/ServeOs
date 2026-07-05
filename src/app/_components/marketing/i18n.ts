import type { FeatureIconId } from "@/components/brand/FeatureIcon";

export type Locale = "en" | "ar";

type FeatureCopy = Record<FeatureIconId, { title: string; description: string }>;

export type MarketingCopy = {
  dir: "ltr" | "rtl";
  header: { features: string; howItWorks: string; signIn: string; getStarted: string };
  hero: {
    badge: string;
    headlineLead: string;
    headlineHighlight: string;
    subhead: string;
    getStarted: string;
    signIn: string;
    trustNoLockIn: string;
    trustLanguages: string;
  };
  features: { eyebrow: string; heading: string; items: FeatureCopy };
  how: { eyebrow: string; heading: string; steps: { title: string; description: string }[] };
  cta: { headlineLead: string; headlineHighlight: string; getStarted: string };
  footer: { copyright: string };
  toggle: { toArabic: string; toEnglish: string };
};

const en: MarketingCopy = {
  dir: "ltr",
  header: { features: "Features", howItWorks: "How it works", signIn: "Sign in", getStarted: "Get Started" },
  hero: {
    badge: "QR menu · WhatsApp · Web ordering",
    headlineLead: "No restaurant website?",
    headlineHighlight: "Create your own in 1 minute.",
    subhead:
      "Your menu online, orders everywhere — customers order by scanning a table QR, messaging WhatsApp, or your own ordering page. No app to install, and it all lands in one dashboard, synced with your POS and stock.",
    getStarted: "Get Started",
    signIn: "Sign in",
    trustNoLockIn: "No hardware lock-in",
    trustLanguages: "English, Spanish, Arabic",
  },
  features: {
    eyebrow: "What you get",
    heading: "Everything your restaurant needs to take orders online.",
    items: {
      "ic-qr": {
        title: "QR Menu & Ordering",
        description: "Every table gets a menu customers can browse and order from in seconds.",
      },
      "ic-chat": {
        title: "WhatsApp Ordering",
        description: "No app required — customers order straight from a chat they already have open.",
      },
      "ic-table": {
        title: "Table Reservations",
        description: "Take bookings without a phone tied up all service.",
      },
      "ic-pos": {
        title: "Point of Sale",
        description: "One system for online orders and in-house sales — nothing to reconcile by hand.",
      },
      "ic-inventory": {
        title: "Inventory Control",
        description: "Stock updates as orders come in, so you know what's running low.",
      },
      "ic-analytics": {
        title: "Live Analytics",
        description: "See what's selling, when, and where — as it happens.",
      },
    },
  },
  how: {
    eyebrow: "How it works",
    heading: "Live in three steps.",
    steps: [
      { title: "Build your menu", description: "Categories, products, photos — in English and Arabic." },
      { title: "Customers order", description: "QR at the table, WhatsApp, or your ordering link." },
      { title: "It all lands in your dashboard", description: "Orders, POS, and stock update together." },
    ],
  },
  cta: {
    headlineLead: "No restaurant website?",
    headlineHighlight: "Create your own in 1 minute.",
    getStarted: "Get Started",
  },
  footer: { copyright: "© 2026 ServeOS" },
  toggle: { toArabic: "العربية", toEnglish: "English" },
};

const ar: MarketingCopy = {
  dir: "rtl",
  header: { features: "المميزات", howItWorks: "كيف تعمل", signIn: "تسجيل الدخول", getStarted: "ابدأ الآن" },
  hero: {
    badge: "قائمة QR · واتساب · طلب عبر الويب",
    headlineLead: "ليس لديك موقع لمطعمك؟",
    headlineHighlight: "أنشئ موقعك في دقيقة واحدة.",
    subhead:
      "قائمتك أونلاين وطلباتك في كل مكان — يطلب عملاؤك بمسح رمز QR على الطاولة، أو عبر واتساب، أو من صفحة الطلب الخاصة بك. دون أي تطبيق، وكل شيء يصل إلى لوحة تحكم واحدة متزامنة مع نقطة البيع والمخزون.",
    getStarted: "ابدأ الآن",
    signIn: "تسجيل الدخول",
    trustNoLockIn: "دون التقيد بأجهزة معينة",
    trustLanguages: "الإنجليزية والإسبانية والعربية",
  },
  features: {
    eyebrow: "ما الذي تحصل عليه",
    heading: "كل ما يحتاجه مطعمك لاستقبال الطلبات أونلاين.",
    items: {
      "ic-qr": {
        title: "قائمة وطلب عبر QR",
        description: "كل طاولة تحصل على قائمة يتصفحها العملاء ويطلبون منها في ثوانٍ.",
      },
      "ic-chat": {
        title: "الطلب عبر واتساب",
        description: "دون تطبيق — يطلب العملاء مباشرة من محادثة مفتوحة لديهم بالفعل.",
      },
      "ic-table": {
        title: "حجز الطاولات",
        description: "استقبل الحجوزات دون انشغال الهاتف طوال الخدمة.",
      },
      "ic-pos": {
        title: "نقطة البيع",
        description: "نظام واحد للطلبات أونلاين والمبيعات داخل المطعم — دون مطابقة يدوية.",
      },
      "ic-inventory": {
        title: "إدارة المخزون",
        description: "يتحدث المخزون مع كل طلب، فتعرف ما الذي أوشك على النفاد.",
      },
      "ic-analytics": {
        title: "تحليلات مباشرة",
        description: "شاهد ما الذي يُباع، ومتى، وأين — لحظة بلحظة.",
      },
    },
  },
  how: {
    eyebrow: "كيف تعمل",
    heading: "انطلق في ثلاث خطوات.",
    steps: [
      { title: "أنشئ قائمتك", description: "الأصناف والمنتجات والصور — بالعربية والإنجليزية." },
      { title: "يطلب عملاؤك", description: "رمز QR على الطاولة، أو واتساب، أو رابط الطلب الخاص بك." },
      { title: "يصل كل شيء إلى لوحتك", description: "الطلبات ونقطة البيع والمخزون تتحدث معًا." },
    ],
  },
  cta: {
    headlineLead: "ليس لديك موقع لمطعمك؟",
    headlineHighlight: "أنشئ موقعك في دقيقة واحدة.",
    getStarted: "ابدأ الآن",
  },
  footer: { copyright: "© 2026 ServeOS" },
  toggle: { toArabic: "العربية", toEnglish: "English" },
};

export const marketingDict: Record<Locale, MarketingCopy> = { en, ar };
