import { CalendarClock, ShieldCheck, Pill, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const pharmacy: Localized<TradeContent> = {
  ar: {
    label: "صيدليات",
    badge: "تشغيلات · صلاحية · وصفات",
    headlineLead: "مش لاقي موقع لصيدليتك؟",
    subhead:
      "رفوفك أونلاين، وكاونترك ملتزم — بيع الأدوية اللي من غير وصفة من متجرك، واصرف الوصفة على الكاونتر، ومتبيعش علبة منتهية الصلاحية خالص. لوحة واحدة للمخزون والتشغيلات والمبيعات.",
    photoCaption: "صيدلية شغّالة، مش برنامج تاني.",
    features: [
      { icon: CalendarClock, title: "التشغيلة والصلاحية", description: "كل علبة عليها رقم التشغيلة وتاريخ الصلاحية — والكاونتر يرفض اللي منتهي." },
      { icon: ShieldCheck, title: "صرف الوصفات", description: "ميّز الأدوية اللي محتاجة وصفة أو رقابة، عشان ما تتصرفش من غير تحقق." },
      { icon: Pill, title: "البدائل الجنيسة", description: "اعرض البديل المكافئ لما الصنف التجاري يخلص.", roadmap: true },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للكاونتر والويب — من غير مصالحة يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "كل بيعة بتحرّك المخزون، فالرف والشاشة يفضلوا متطابقين." },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف بيتحرك إيه، وإيه اللي قرب يخلص، وفي أي فرع." },
    ],
    steps: [
      { title: "جهّز رفوفك", description: "المنتجات والتشغيلات وتواريخ الصلاحية — بالعربي والإنجليزي." },
      { title: "اخدم الكاونتر", description: "بيع من غير وصفة، ووصفات طبية، وبدائل." },
      { title: "كله في لوحة واحدة", description: "المبيعات والمخزون والتشغيلات القريبة من الانتهاء بيتحدثوا سوا." },
    ],
    ticket: {
      ref: "طلب #٧٧٦",
      channel: "كاونتر · وصفة",
      lines: [
        { qty: "٢×", name: "باراسيتامول ٥٠٠ ملغ", meta: "تشغيلة B-2291 · تنتهي ٠٤/٢٧", amount: "٢٤٫٠٠" },
        { qty: "١×", name: "أموكسيسيلين ٢٥٠ ملغ", meta: "يحتاج وصفة · تم التحقق", amount: "٦٠٫٠٠" },
      ],
      status: "لسه عند الصيدلي",
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
