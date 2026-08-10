import type { Localized } from "./types";

export type FaqContent = { eyebrow: string; heading: string; items: { q: string; a: string }[] };

export const FAQ: Localized<FaqContent> = {
  ar: {
    eyebrow: "أسئلة شائعة",
    heading: "الأسئلة اللي بتيجي قبل الاشتراك.",
    items: [
      { q: "محتاج أجهزة معينة؟", a: "لأ. ServeOS شغّال من المتصفح على أي لابتوب أو تابلت أو موبايل. لو عندك طابعة أو درج كاش موجود، بيشتغلوا معاه." },
      { q: "بياناتي ملكي؟", a: "أيوه. المنتجات والطلبات والزباين بتاعتك، وتقدر تصدّرها في أي وقت." },
      { q: "لو وقّفت الاشتراك بيحصل إيه؟", a: "حسابك بينزل للباقة المجانية وبياناتك بتفضل موجودة. مفيش حذف عند الإيقاف." },
      { q: "بتشتغل من غير إنترنت؟", a: "نقطة البيع بتكمّل بيع وقت انقطاع النت وبتزامن أول ما يرجع. المتجر وواتساب محتاجين اتصال." },
      { q: "الدعم بالعربي؟", a: "أيوه، والواجهة كلها عربي بالكامل من اليمين لليسار." },
      { q: "فيه عقد أو التزام طويل؟", a: "أقل مدة اشتراك ثلاثة شهور، وتقدر تلغي التجديد في أي وقت. الباقة المجانية من غير أي التزام." },
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
      { q: "Is support in Arabic?", a: "Yes, and the entire interface is fully Arabic, right-to-left." },
      { q: "Is there a contract?", a: "The minimum term is three months and you can cancel renewal at any time. The free plan has no commitment at all." },
    ],
  },
};
