import type { Localized } from "./types";

/** The surface keys are also the screenshot filenames — see _lib/shots.ts. */
export const SURFACE_KEYS = ["storefront", "dashboard", "pos"] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

export type SurfacesContent = {
  eyebrow: string;
  heading: string;
  /** `bullets` are concrete capabilities, not slogans. They exist to give the
   *  copy column real vertical content against a tall screenshot — a heading and
   *  one sentence leaves a void beside it. Three per surface. */
  bands: Record<SurfaceKey, { title: string; body: string; bullets: string[]; callout: string }>;
  whatsapp: {
    title: string;
    body: string;
    bullets: string[];
    callout: string;
    chat: { from: "shop" | "customer"; text: string }[];
  };
};

export const SURFACES: Localized<SurfacesContent> = {
  ar: {
    eyebrow: "المنتج",
    heading: "ده شكل الشغل من جوه.",
    bands: {
      storefront: {
        title: "المتجر",
        body: "صفحة طلب بالعربي على نطاقك، مصمَّمة للهاتف قبل أي شيء آخر.",
        bullets: ["نطاقك الخاص أو نطاق فرعي مجاني", "أسماء المنتجات بالعربية والإنجليزية", "طلب بالكود على الطاولة أو من رابط مباشر"],
        callout: "بدون تطبيق ينزّله الزبون",
      },
      dashboard: {
        title: "لوحة التحكم",
        body: "الطلبات والمنتجات والفروع والتقارير في مكان واحد، لحظة بلحظة.",
        bullets: ["الطلبات تصل فور إنشائها", "صلاحيات مختلفة لكل موظف", "تقرير واحد يقارن الفروع"],
        callout: "الطلبات بتوصل وهي جاية",
      },
      pos: {
        title: "نقطة البيع",
        body: "نقطة بيع كاملة على أي جهاز، ومبيعاتها تُجمَع مع الأونلاين في التقرير نفسه.",
        bullets: ["يعمل دون انقطاع عند ضعف الشبكة", "طباعة إيصال ودرج نقدية", "وردية وتسوية نقدية لكل موظف"],
        callout: "من غير مصالحة يدوية",
      },
    },
    whatsapp: {
      title: "واتساب",
      body: "يطلب العميل من محادثة مفتوحة لديه بالفعل، ويصل الطلب إلى لوحة التحكم كأي طلب آخر.",
      bullets: ["دون تطبيق يثبّته العميل", "سلة الطلب تنتقل إلى المتجر بضغطة", "سجل المحادثة مرتبط بالطلب"],
      callout: "نفس القناة التي يستخدمها كل يوم",
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
        bullets: ["Your own domain, or a free subdomain", "Product names in Arabic and English", "Order from a table QR or a direct link"],
        callout: "No app for the customer to install",
      },
      dashboard: {
        title: "Dashboard",
        body: "Orders, products, branches and reporting — one place, updating live.",
        bullets: ["Orders arrive the moment they are placed", "Per-role permissions for every member of staff", "One report that compares branches"],
        callout: "Orders arrive as they happen",
      },
      pos: {
        title: "Point of sale",
        body: "A full counter on any device, with till sales landing in the same report as online.",
        bullets: ["Keeps selling through a weak connection", "Receipt printing and cash drawer", "Shift and cash-up per member of staff"],
        callout: "Nothing to reconcile by hand",
      },
    },
    whatsapp: {
      title: "WhatsApp",
      body: "Customers order from a chat they already have open, and it lands in the dashboard like any other order.",
      bullets: ["No app for the customer to install", "The basket carries over to the storefront", "The conversation stays attached to the order"],
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
