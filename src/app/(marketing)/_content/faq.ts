import type { Localized } from "./types";

export type FaqContent = { eyebrow: string; heading: string; items: { q: string; a: string }[] };

export const FAQ: Localized<FaqContent> = {
  ar: {
    eyebrow: "أسئلة شائعة",
    heading: "الأسئلة التي تسبق الاشتراك عادةً.",
    items: [
      { q: "هل أحتاج أجهزة معيّنة؟", a: "لا. يعمل ServeOS من المتصفح على أي حاسوب محمول أو جهاز لوحي أو هاتف. وإن كانت لديك طابعة أو درج نقدية، فهما يعملان معه." },
      { q: "هل بياناتي ملكي؟", a: "نعم. المنتجات والطلبات والعملاء ملكك، ويمكنك تصديرها في أي وقت." },
      { q: "ماذا يحدث إذا أوقفت الاشتراك؟", a: "ينتقل حسابك إلى الباقة المجانية وتبقى بياناتك كما هي. لا يُحذف شيء عند الإيقاف." },
      { q: "هل يعمل دون إنترنت؟", a: "تواصل نقطة البيع العمل عند انقطاع الاتصال وتُزامن بياناتها فور عودته. أما المتجر وواتساب فيحتاجان اتصالًا." },
      {
        q: "هل الدعم بالعربية؟",
        a: "نعم، الدعم بالعربية. وتُسجَّل منتجاتك بالعربية والإنجليزية معًا، فيرى العميل الأسماء العربية في المتجر. أما لوحة التحكم فهي بالإنجليزية حاليًا، وتعريبها قادم.",
      },
      { q: "هل هناك عقد أو التزام طويل؟", a: "أقل مدة اشتراك ثلاثة أشهر، ويمكنك إلغاء التجديد في أي وقت. والباقة المجانية دون أي التزام." },
    ],
  },
  en: {
    eyebrow: "FAQ",
    heading: "What people ask before signing up.",
    items: [
      { q: "Do I need specific hardware?", a: "No. ServeOS runs in the browser on any laptop, tablet or phone. If you already have a printer or cash drawer, they work with it." },
      { q: "Is my data mine?", a: "Yes. Your products, orders and customers are yours, and you can export them at any time." },
      { q: "What happens if I stop paying?", a: "Your account drops to the free plan and your data stays. Nothing is deleted on cancellation." },
      { q: "Does it work offline?", a: "The point of sale keeps selling through a dropout and syncs when the connection returns. The storefront and WhatsApp need a connection." },
      {
        q: "Is support in Arabic?",
        a: "Yes, support is in Arabic. Your products carry both Arabic and English names, so customers see the Arabic ones in your storefront. The dashboard itself is English today, with Arabic on the way.",
      },
      { q: "Is there a contract?", a: "The minimum term is three months and you can cancel renewal at any time. The free plan has no commitment at all." },
    ],
  },
};
