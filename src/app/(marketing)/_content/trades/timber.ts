import { Ruler, Scissors, Truck, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const timber: Localized<TradeContent> = {
  ar: {
    label: "أخشاب",
    badge: "بيع بالأبعاد · قص حسب الطلب · توصيل",
    headlineLead: "مش لاقي موقع لمستودع الأخشاب؟",
    subhead:
      "مستودعك أونلاين، وقائمة القص متزامنة معاه — الزبون يطلب الألواح بالأبعاد، وانت تسعّر بالمتر المكعب، وكل قصة وتوصيلة، كله بيوصل لوحة تحكم واحدة.",
    photoCaption: "المقاس بالمتر، والحساب مظبوط.",
    features: [
      { icon: Ruler, title: "البيع بالأبعاد", description: "سعّر بالمتر المكعب، أو الطولي، أو باللوح — مش بالقطعة.", roadmap: true },
      { icon: Scissors, title: "قوائم القص", description: "الطلب معاه قائمة القص، فالمنشار يعرف قبل ما الزبون يوصل.", roadmap: true },
      { icon: Truck, title: "التوصيل والاستلام", description: "استلام من المستودع، أو توصيل للموقع، بسعر على حسب المنطقة." },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد لكاونتر المستودع والويب — من غير مصالحة يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "كل قصة بتحرّك المخزون، فالرف والشاشة يفضلوا متطابقين.", roadmap: true },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف أي الأنواع والمقاسات بتتحرك، وإيه اللي راكد في الرف." },
    ],
    steps: [
      { title: "أدرج مخزونك", description: "الأنواع والدرجات والأبعاد — بسعر لكل وحدة قياس." },
      { title: "الزبون يطلب", description: "بالأبعاد، مقصوص على المقاس، للاستلام أو التوصيل." },
      { title: "كله في لوحة واحدة", description: "قوائم القص والمخزون والتوصيلات بيتحدثوا سوا." },
    ],
    ticket: {
      ref: "أمر #٣١٨",
      channel: "مستودع · قص حسب الطلب",
      lines: [
        { qty: "٢×", name: "لوح بلوط", meta: "٢٤٠٠ × ٣٠٠ × ١٨ مم · ٠٫٠٢٦ م٣", amount: "٤١٠٫٠٠" },
        { qty: "١٢×", name: "عارضة صنوبر", meta: "٢٫٤ م · ٢٨٫٨ متر طولي", amount: "١٩٠٫٠٠" },
      ],
      status: "بيتقص دلوقتي",
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
      { icon: Ruler, title: "Sold by Dimension", description: "Price by cubic metre, linear metre, or sheet — not by the piece.", roadmap: true },
      { icon: Scissors, title: "Cut-to-Order Lists", description: "The order carries the cut list, so the saw knows before the customer arrives.", roadmap: true },
      { icon: Truck, title: "Delivery & Collection", description: "Yard collection or site delivery, priced by area." },
      { icon: Monitor, title: "Point of Sale", description: "One system for the yard counter and the web — nothing to reconcile by hand." },
      { icon: Package, title: "Stock Control", description: "Every cut moves stock, so the rack and the screen agree.", roadmap: true },
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
