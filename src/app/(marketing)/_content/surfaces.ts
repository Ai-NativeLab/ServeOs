import type { Localized } from "./types";

/** The surface keys are also the screenshot filenames — see _lib/shots.ts. */
export const SURFACE_KEYS = ["storefront", "dashboard", "pos"] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

export type SurfacesContent = {
  eyebrow: string;
  heading: string;
  bands: Record<SurfaceKey, { title: string; body: string; callout: string }>;
  whatsapp: { title: string; body: string; callout: string; chat: { from: "shop" | "customer"; text: string }[] };
};

export const SURFACES: Localized<SurfacesContent> = {
  ar: {
    eyebrow: "المنتج",
    heading: "ده شكل الشغل من جوه.",
    bands: {
      storefront: {
        title: "المتجر",
        body: "صفحة طلب بالعربي على النطاق بتاعك، شغالة على الموبايل قبل أي حاجة.",
        callout: "بدون تطبيق ينزّله الزبون",
      },
      dashboard: {
        title: "لوحة التحكم",
        body: "الطلبات، المنتجات، الفروع، والتقارير — في مكان واحد ولحظة بلحظة.",
        callout: "الطلبات بتوصل وهي جاية",
      },
      pos: {
        title: "نقطة البيع",
        body: "كاشير كامل على أي جهاز، والمبيعات بتتجمع مع الأونلاين في نفس التقرير.",
        callout: "من غير مصالحة يدوية",
      },
    },
    whatsapp: {
      title: "واتساب",
      body: "الزبون بيطلب من شات فاتح عنده أصلًا، والطلب بيدخل لوحة التحكم زي أي طلب تاني.",
      callout: "نفس القناة اللي بيستخدمها كل يوم",
      chat: [
        { from: "customer", text: "عايز أطلب" },
        { from: "shop", text: "أهلًا 👋 اتفضل القائمة" },
        { from: "customer", text: "٢ شاورما و١ ليمون بالنعناع" },
        { from: "shop", text: "تمام — الإجمالي ٢١٥ ج.م" },
      ],
    },
  },
  en: {
    eyebrow: "The product",
    heading: "This is what the work actually looks like.",
    bands: {
      storefront: {
        title: "Storefront",
        body: "An Arabic ordering page on your own domain, built mobile-first.",
        callout: "No app for the customer to install",
      },
      dashboard: {
        title: "Dashboard",
        body: "Orders, products, branches and reporting — one place, updating live.",
        callout: "Orders arrive as they happen",
      },
      pos: {
        title: "Point of sale",
        body: "A full counter on any device, with till sales landing in the same report as online.",
        callout: "Nothing to reconcile by hand",
      },
    },
    whatsapp: {
      title: "WhatsApp",
      body: "Customers order from a chat they already have open, and it lands in the dashboard like any other order.",
      callout: "The channel they already use daily",
      chat: [
        { from: "customer", text: "I'd like to order" },
        { from: "shop", text: "Hi 👋 here's the menu" },
        { from: "customer", text: "2 shawarma and 1 mint lemonade" },
        { from: "shop", text: "Done — total is EGP 215" },
      ],
    },
  },
};
