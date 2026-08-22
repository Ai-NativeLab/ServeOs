import { CalendarClock, ShieldCheck, Pill, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const pharmacy: Localized<TradeContent> = {
  ar: {
    label: "صيدليات",
    badge: "تشغيلات · صلاحية · وصفات",
    headlineLead: "ألا تملك موقعًا لصيدليتك؟",
    subhead:
      "رفوفك على الإنترنت، ومنضدتك ملتزمة — بِع الأدوية التي لا تحتاج وصفة من متجرك، واصرف الوصفة على المنضدة، ولا تبِع عبوة منتهية الصلاحية أبدًا. لوحة واحدة للمخزون والتشغيلات والمبيعات.",
    photoCaption: "صيدلية تعمل، لا برنامج آخر.",
    features: [
      { icon: CalendarClock, title: "التشغيلة والصلاحية", description: "لكل عبوة رقم تشغيلة وتاريخ صلاحية — وترفض المنضدة ما انتهت صلاحيته." },
      { icon: ShieldCheck, title: "صرف الوصفات", description: "ميّز الأدوية التي تحتاج وصفة أو رقابة، حتى لا تُصرف دون تحقّق." },
      { icon: Pill, title: "البدائل الجنيسة", description: "اعرض البديل المكافئ عند نفاد الصنف التجاري.", roadmap: true },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للمنضدة والويب — دون تسوية يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "تُحرّك كل عملية بيع المخزون، فيبقى الرف والشاشة متطابقين." },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف ما يتحرك، وما أوشك على النفاد، وفي أي فرع." },
    ],
    steps: [
      { title: "جهّز رفوفك", description: "المنتجات والتشغيلات وتواريخ الصلاحية — بالعربية والإنجليزية." },
      { title: "اخدم الكاونتر", description: "بيع دون وصفة، ووصفات طبية، وبدائل." },
      { title: "كل شيء في لوحة واحدة", description: "تتحدّث المبيعات والمخزون والتشغيلات القريبة من الانتهاء معًا." },
    ],
    ticket: {
      ref: "طلب #٧٧٦",
      channel: "منضدة · وصفة",
      lines: [
        { qty: "٢×", name: "باراسيتامول ٥٠٠ ملغ", meta: "تشغيلة B-2291 · تنتهي ٠٤/٢٧", amount: "٢٤٫٠٠" },
        { qty: "١×", name: "أموكسيسيلين ٢٥٠ ملغ", meta: "يحتاج وصفة · تم التحقق", amount: "٦٠٫٠٠" },
      ],
      status: "ما زال لدى الصيدلي",
      total: "٨٤٫٠٠",
    },
  },
  en: {
    label: "Pharmacy",
    badge: "Batches · Expiry · Prescriptions",
    headlineLead: "No pharmacy website?",
    subhead:
      "Your shelf online, your counter compliant — sell over-the-counter lines from a storefront, handle prescriptions at the counter, and never sell an expired box. One dashboard for stock, batches, and sales.",
    photoCaption: "A working pharmacy, not another program.",
    features: [
      { icon: CalendarClock, title: "Batch & Expiry", description: "Every box carries its batch and expiry date — the counter blocks what's out of date." },
      { icon: ShieldCheck, title: "Prescription Handling", description: "Flag Rx-only and controlled lines so they never leave the counter unchecked." },
      { icon: Pill, title: "Generic Substitutes", description: "Offer the equivalent when the brand is out of stock.", roadmap: true },
      { icon: Monitor, title: "Point of Sale", description: "One system for the counter and the web — nothing to reconcile by hand." },
      { icon: Package, title: "Stock Control", description: "Every sale moves stock, so the shelf and the screen agree." },
      { icon: ChartColumn, title: "Live Analytics", description: "See what's moving, what's expiring, and in which branch." },
    ],
    steps: [
      { title: "Load your shelf", description: "Products, batches, and expiry dates — in English and Arabic." },
      { title: "Serve the counter", description: "Over-the-counter sales, prescriptions, and substitutes." },
      { title: "It all lands in your dashboard", description: "Sales, stock, and expiring batches update together." },
    ],
    ticket: {
      ref: "Order #776",
      channel: "Counter · Rx",
      lines: [
        { qty: "2×", name: "Paracetamol 500mg", meta: "batch B-2291 · exp 04/27", amount: "24.00" },
        { qty: "1×", name: "Amoxicillin 250mg", meta: "Rx required · verified", amount: "60.00" },
      ],
      status: "Awaiting pharmacist",
      total: "84.00",
    },
  },
};
