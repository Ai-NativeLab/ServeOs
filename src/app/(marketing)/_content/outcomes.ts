import type { Localized } from "./types";

export type OutcomeItem = {
  scenario: string;
  situation: string;
  result: string;
  /** Set only when a real, consenting customer has given a quote. */
  attribution?: { name: string; role: string };
};

export type OutcomesContent = { eyebrow: string; heading: string; label: string; items: OutcomeItem[] };

export const OUTCOMES: Localized<OutcomesContent> = {
  ar: {
    eyebrow: "أمثلة من السوق",
    heading: "شكل العمل قبل وبعد.",
    label: "نماذج توضيحية",
    items: [
      {
        scenario: "سلسلة كشري بثلاثة فروع",
        situation: "يسجّل كل فرع مبيعاته على حدة، وتتم المقارنة بينها آخر الشهر على الورق.",
        result: "تقرير واحد يقارن الفروع لحظيًا، والطلب الأونلاين ضمن الحساب نفسه.",
      },
      {
        scenario: "صيدلية في فيصل",
        situation: "تضيع طلبات واتساب بين الرسائل، ويُراجَع المخزون يدويًا.",
        result: "يتحوّل الطلب إلى أوردر في لوحة التحكم، ويُسجَّل الصرف مع البيع.",
      },
      {
        scenario: "مخزن أخشاب في الشيخ زايد",
        situation: "يُحسب كل مقاس بالآلة الحاسبة، ويختلف السعر من بائع إلى آخر.",
        result: "التسعير بالمقاس مُسجَّل في النظام، فالسعر واحد أيًّا كان البائع.",
      },
    ],
  },
  en: {
    eyebrow: "Examples from the market",
    heading: "What the work looks like before and after.",
    label: "Illustrative",
    items: [
      {
        scenario: "A three-branch koshary chain",
        situation: "Each branch records its own sales, and comparing them happens on paper at month end.",
        result: "One report compares branches live, with online orders in the same account.",
      },
      {
        scenario: "A pharmacy in Faisal",
        situation: "WhatsApp orders get lost between messages and stock is adjusted by hand.",
        result: "The message becomes an order in the dashboard, and dispensing is recorded with the sale.",
      },
      {
        scenario: "A timber yard in Sheikh Zayed",
        situation: "Every cut is priced on a calculator, and the number changes with whoever is serving.",
        result: "Dimensional pricing lives in the system, so the price is the same whoever sells it.",
      },
    ],
  },
};
