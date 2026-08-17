import { Ruler, Scissors, Truck, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const timber: Localized<TradeContent> = {
  ar: {
    label: "أخشاب",
    badge: "بيع بالأبعاد · قص حسب الطلب · توصيل",
    headlineLead: "ألا تملك موقعًا لمستودع الأخشاب؟",
    subhead:
      "مستودعك على الإنترنت، وقائمة القص متزامنة معه — يطلب العميل الألواح بالأبعاد، وأنت تسعّر بالمتر المكعب، وكل قَصّة وتوصيلة تصل إلى لوحة تحكم واحدة.",
    photoCaption: "المقاس بالمتر، والحساب دقيق.",
    features: [
      { icon: Ruler, title: "البيع بالأبعاد", description: "سعّر بالمتر المكعب، أو المتر الطولي، أو باللوح — لا بالقطعة." },
      { icon: Scissors, title: "قوائم القص", description: "يرافق الطلبَ قائمةُ قصّه، فيعرف المنشار قبل وصول العميل.", roadmap: true },
      { icon: Truck, title: "التوصيل والاستلام", description: "استلام من المستودع، أو توصيل إلى الموقع، بسعر يتبع المنطقة." },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد لمنضدة المستودع والويب — دون تسوية يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "تُحرّك كل قَصّة المخزون، فيبقى الرف والشاشة متطابقين." },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف أي الأنواع والمقاسات تتحرك، وما الراكد على الرف." },
    ],
    steps: [
      { title: "أدرج مخزونك", description: "الأنواع والدرجات والأبعاد — بسعر لكل وحدة قياس." },
      { title: "يطلب العميل", description: "بالأبعاد، مقصوص على المقاس، للاستلام أو التوصيل." },
      { title: "كل شيء في لوحة واحدة", description: "تتحدّث قوائم القص والمخزون والتوصيلات معًا." },
    ],
    ticket: {
      ref: "أمر #٣١٨",
      channel: "مستودع · قص حسب الطلب",
      lines: [
        { qty: "٢×", name: "لوح بلوط", meta: "٢٤٠٠ × ٣٠٠ × ١٨ مم · ٠٫٠٢٦ م٣", amount: "٤١٠٫٠٠" },
        { qty: "١٢×", name: "عارضة صنوبر", meta: "٢٫٤ م · ٢٨٫٨ متر طولي", amount: "١٩٠٫٠٠" },
      ],
      status: "قيد القص الآن",
      total: "٦٠٠٫٠٠",
    },
  },
  en: {
    label: "Timber",
    badge: "Sold by dimension · Cut to order · Delivery",
    headlineLead: "No timber yard website?",
    subhead:
      "Your yard online, your cut list in sync — customers order boards by dimension, you price by the cubic metre, and every cut, offcut, and delivery lands in one dashboard.",
    photoCaption: "Cut to size, priced to the millimetre.",
    features: [
      { icon: Ruler, title: "Sold by Dimension", description: "Price by cubic metre, linear metre, or sheet — not by the piece." },
      { icon: Scissors, title: "Cut-to-Order Lists", description: "The order carries the cut list, so the saw knows before the customer arrives.", roadmap: true },
      { icon: Truck, title: "Delivery & Collection", description: "Yard collection or site delivery, priced by area." },
      { icon: Monitor, title: "Point of Sale", description: "One system for the yard counter and the web — nothing to reconcile by hand." },
      { icon: Package, title: "Stock Control", description: "Every cut moves stock, so the rack and the screen agree." },
      { icon: ChartColumn, title: "Live Analytics", description: "See which species and sizes move, and what's sitting in the rack." },
    ],
    steps: [
      { title: "List your stock", description: "Species, grades, and dimensions — priced per unit of measure." },
      { title: "Customers order", description: "By dimension, cut to size, for collection or delivery." },
      { title: "It all lands in your dashboard", description: "Cut lists, stock, and deliveries update together." },
    ],
    ticket: {
      ref: "Job #318",
      channel: "Yard · Cut to order",
      lines: [
        { qty: "2×", name: "Oak plank", meta: "2400 × 300 × 18mm · 0.026 m³", amount: "410.00" },
        { qty: "12×", name: "Pine batten", meta: "2.4m · 28.8 linear m", amount: "190.00" },
      ],
      status: "Cutting",
      total: "600.00",
    },
  },
};
