import type { Localized } from "./types";

export type StoryContent = { eyebrow: string; heading: string; body: string[] };

export const STORY: Localized<StoryContent> = {
  ar: {
    eyebrow: "لماذا بنينا ServeOS",
    heading: "ثلاثة أنظمة، لا يتحدث أيٌّ منها إلى الآخر.",
    body: [
      "يدفع المتجر المصري اليوم لنظام نقاط بيع، وعمولة لتطبيق توصيل، ومصمم يُعدّ له قائمة على وسائل التواصل. ثلاثة أنظمة منفصلة، يرى كلٌّ منها نصف الصورة فقط.",
      "بنينا ServeOS ليصل الطلب من الطاولة ومن واتساب ومن المتجر ومن نقطة البيع إلى مكان واحد، بالعربية وبالجنيه المصري.",
    ],
  },
  en: {
    eyebrow: "Why we built ServeOS",
    heading: "Three systems, none of them talking.",
    body: [
      "An Egyptian shop today pays for a POS, a commission to a delivery app, and a designer to make a menu for social media. Three separate things, each seeing half the picture.",
      "We built ServeOS so an order from the table, from WhatsApp, from your storefront and from the counter all land in one place — in Arabic, priced in Egyptian pounds.",
    ],
  },
};
