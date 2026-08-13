import { QrCode, MessageCircle, CalendarCheck, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const restaurant: Localized<TradeContent> = {
  ar: {
    label: "مطاعم",
    badge: "قائمة QR · واتساب · طلب أونلاين",
    headlineLead: "ألا تملك موقعًا لمطعمك؟",
    subhead:
      "قائمتك على الإنترنت، والطلبات تصلك من كل مكان — يمسح العميل رمزًا على الطاولة، أو يراسلك على واتساب، أو يطلب من صفحتك. وكلها تصل إلى لوحة تحكم واحدة.",
    photoCaption: "من خلف المنضدة، لا من خلف مكتب.",
    features: [
      { icon: QrCode, title: "قائمة وطلب بالـ QR", description: "لكل طاولة قائمة يتصفحها العميل ويطلب منها في ثوانٍ." },
      { icon: MessageCircle, title: "الطلب من واتساب", description: "دون تطبيق — يطلب العميل من محادثة مفتوحة لديه بالفعل." },
      { icon: CalendarCheck, title: "حجز الطاولات", description: "استقبل الحجوزات دون أن ينشغل الهاتف طوال الخدمة.", roadmap: true },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للطلبات الأونلاين ومبيعات المتجر — دون تسوية يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "يتحدّث المخزون مع كل طلب، فتعرف ما أوشك على النفاد." },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف ما يُباع، ومتى، وأين — أولًا بأول." },
    ],
    steps: [
      { title: "أنشئ قائمتك", description: "أقسام ومنتجات وصور — بالعربية والإنجليزية." },
      { title: "يطلب العميل", description: "رمز على الطاولة، أو واتساب، أو رابط الطلب." },
      { title: "كل شيء في لوحة واحدة", description: "تتحدّث الطلبات ونقطة البيع والمخزون معًا." },
    ],
    ticket: {
      ref: "طاولة ٤",
      channel: "داخل المتجر · QR",
      lines: [
        { qty: "٢×", name: "طبق شاورما", meta: "ثوم إضافي، دون مخلل", amount: "١٨٠٫٠٠" },
        { qty: "١×", name: "ليمون بالنعناع", meta: "كبير", amount: "٣٥٫٠٠" },
      ],
      status: "جهّز الآن",
      total: "٢١٥٫٠٠",
    },
  },
  en: {
    label: "Restaurant",
    badge: "QR menu · WhatsApp · Web ordering",
    headlineLead: "No restaurant website?",
    subhead:
      "Your menu online, orders everywhere — customers order by scanning a table QR, messaging WhatsApp, or your own ordering page. No app to install, and it all lands in one dashboard.",
    photoCaption: "Built for behind the counter, not behind a desk.",
    features: [
      { icon: QrCode, title: "QR Menu & Ordering", description: "Every table gets a menu customers can browse and order from in seconds." },
      { icon: MessageCircle, title: "WhatsApp Ordering", description: "No app required — customers order straight from a chat they already have open." },
      { icon: CalendarCheck, title: "Table Reservations", description: "Take bookings without a phone tied up all service.", roadmap: true },
      { icon: Monitor, title: "Point of Sale", description: "One system for online orders and in-house sales — nothing to reconcile by hand." },
      { icon: Package, title: "Inventory Control", description: "Stock updates as orders come in, so you know what's running low." },
      { icon: ChartColumn, title: "Live Analytics", description: "See what's selling, when, and where — as it happens." },
    ],
    steps: [
      { title: "Build your menu", description: "Categories, products, photos — in English and Arabic." },
      { title: "Customers order", description: "QR at the table, WhatsApp, or your ordering link." },
      { title: "It all lands in your dashboard", description: "Orders, POS, and stock update together." },
    ],
    ticket: {
      ref: "Table 4",
      channel: "Dine-in · QR",
      lines: [
        { qty: "2×", name: "Shawarma Plate", meta: "extra garlic, no pickles", amount: "180.00" },
        { qty: "1×", name: "Mint Lemonade", meta: "large", amount: "35.00" },
      ],
      status: "Fire now",
      total: "215.00",
    },
  },
};
