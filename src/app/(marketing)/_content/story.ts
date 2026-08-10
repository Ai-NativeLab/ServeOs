import type { Localized } from "./types";

export type StoryContent = { eyebrow: string; heading: string; body: string[] };

export const STORY: Localized<StoryContent> = {
  ar: {
    eyebrow: "ليه بنينا ServeOS",
    heading: "ثلاثة أنظمة، ولا واحد فيهم بيكلّم التاني.",
    body: [
      "المحل المصري النهارده بيدفع لنظام كاشير، وعمولة لتطبيق توصيل، ومصمم يعملّه قائمة على السوشيال ميديا. تلات حاجات منفصلة، وكل واحدة بتشوف نص الصورة.",
      "بنينا ServeOS عشان الطلب اللي جاي من الطاولة، ومن واتساب، ومن المتجر، ومن الكاشير — كله يوصل لمكان واحد، بالعربي، وبالجنيه المصري.",
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
