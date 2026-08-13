import { ScanBarcode, Layers, Globe, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const retail: Localized<TradeContent> = {
  ar: {
    label: "متاجر",
    badge: "باركود · متجر إلكتروني · كاونتر",
    headlineLead: "ألا تملك موقعًا لمتجرك؟",
    subhead:
      "كتالوجك على الإنترنت، ومنضدتك متزامنة معه — يشتري العميل من المتجر، أو بمسح باركود، أو من متجرك الإلكتروني. والمخزون والمبيعات والفواتير كلها تصل إلى لوحة تحكم واحدة.",
    photoCaption: "من الرف للفاتورة في نفس النظام.",
    features: [
      { icon: ScanBarcode, title: "الدفع بالباركود", description: "امسح، وسجّل، وانتهى الأمر — منضدة تواكب الطابور.", roadmap: true },
      { icon: Layers, title: "الأنواع والمقاسات", description: "المقاس واللون والعبوة — لكلٍّ سعره ومخزونه المستقل." },
      { icon: Globe, title: "متجر إلكتروني", description: "الكتالوج نفسه الذي يبيع منه متجرك، متاح على الإنترنت." },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للمنضدة والويب — دون تسوية يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "تُحرّك كل عملية بيع المخزون، فيبقى الرف والشاشة متطابقين." },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف ما يُباع، ومتى، وفي أي فرع — أولًا بأول." },
    ],
    steps: [
      { title: "أنشئ كتالوجك", description: "المنتجات والمقاسات والباركود — بالعربية والإنجليزية." },
      { title: "يشتري العميل", description: "من المنضدة، أو بمسح باركود، أو من رابط متجرك." },
      { title: "كل شيء في لوحة واحدة", description: "تتحدّث المبيعات والمخزون والفواتير معًا." },
    ],
    ticket: {
      ref: "بيع #١٠٤٢",
      channel: "منضدة · باركود",
      lines: [
        { qty: "١×", name: "تيشيرت قطن", meta: "M · رملي · ٨٩٠١٢٣٤٥٦٧", amount: "١٢٠٫٠٠" },
        { qty: "٢×", name: "جوارب، عبوة ٣", meta: "٨٩٠٤٤٤٥١٢٠", amount: "٩٠٫٠٠" },
      ],
      status: "جاهز للمحاسبة",
      total: "٢١٠٫٠٠",
    },
  },
  en: {
    label: "Retail",
    badge: "Barcode · Storefront · Counter",
    headlineLead: "No shop website?",
    subhead:
      "Your catalogue online, your counter in sync — customers buy in the shop, from a barcode scan, or from your own storefront. Stock, sales, and receipts land in one dashboard.",
    photoCaption: "From the shelf to the receipt in one system.",
    features: [
      { icon: ScanBarcode, title: "Barcode Checkout", description: "Scan, ring, done — the counter keeps up with a queue.", roadmap: true },
      { icon: Layers, title: "Variants", description: "Size, colour, and pack — priced and counted separately." },
      { icon: Globe, title: "Online Storefront", description: "The same catalogue your shop sells from, open to the web." },
      { icon: Monitor, title: "Point of Sale", description: "One system for the till and the web — nothing to reconcile by hand." },
      { icon: Package, title: "Stock Control", description: "Every sale moves stock, so the shelf and the screen agree." },
      { icon: ChartColumn, title: "Live Analytics", description: "See what's selling, when, and in which branch — as it happens." },
    ],
    steps: [
      { title: "Build your catalogue", description: "Products, variants, and barcodes — in English and Arabic." },
      { title: "Customers buy", description: "At the counter, by scan, or from your storefront link." },
      { title: "It all lands in your dashboard", description: "Sales, stock, and receipts update together." },
    ],
    ticket: {
      ref: "Sale #1042",
      channel: "Counter · Barcode",
      lines: [
        { qty: "1×", name: "Cotton Tee", meta: "M · Sand · 8901234567", amount: "120.00" },
        { qty: "2×", name: "Socks, 3-pack", meta: "8904445120", amount: "90.00" },
      ],
      status: "Ready to pay",
      total: "210.00",
    },
  },
};
