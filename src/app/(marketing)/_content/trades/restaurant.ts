import { QrCode, MessageCircle, CalendarCheck, Monitor, Package, ChartColumn } from "lucide-react";
import type { Localized } from "../types";
import type { TradeContent } from "./index";

export const restaurant: Localized<TradeContent> = {
  ar: {
    label: "مطاعم",
    badge: "قائمة QR · واتساب · طلب أونلاين",
    headlineLead: "مش لاقي موقع لمطعمك؟",
    subhead:
      "قائمتك أونلاين، والطلبات من كل مكان — الزبون يمسح كود على الطاولة، أو يبعت على واتساب، أو يطلب من صفحتك. كله بيوصل لوحة تحكم واحدة.",
    photoCaption: "من ورا الكاونتر، مش من ورا مكتب.",
    features: [
      { icon: QrCode, title: "قائمة وطلب بالـ QR", description: "كل ترابيزة ليها قائمة الزبون يتصفحها ويطلب منها في ثواني." },
      { icon: MessageCircle, title: "الطلب من واتساب", description: "من غير تطبيق — الزبون يطلب من شات فاتح عنده أصلًا." },
      { icon: CalendarCheck, title: "حجز الطاولات", description: "احجز من غير ما التليفون يفضل مشغول طول الخدمة.", roadmap: true },
      { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للطلبات الأونلاين والمبيعات في المحل — من غير مصالحة يدوية." },
      { icon: Package, title: "إدارة المخزون", description: "المخزون بيتحدث مع كل طلب، فتعرف اللي قرب يخلص.", roadmap: true },
      { icon: ChartColumn, title: "تقارير لحظية", description: "اعرف بيتباع إيه، وإمتى، وفين — أول بأول." },
    ],
    steps: [
      { title: "ابنِ قائمتك", description: "أقسام ومنتجات وصور — بالعربي والإنجليزي." },
      { title: "الزبون يطلب", description: "كود على الطاولة، واتساب، أو لينك الطلب." },
      { title: "كله في لوحة واحدة", description: "الطلبات والكاشير والمخزون بيتحدثوا سوا." },
    ],
    ticket: {
      ref: "ترابيزة ٤",
      channel: "في المحل · QR",
      lines: [
        { qty: "٢×", name: "طبق شاورما", meta: "توم زيادة، من غير مخلل", amount: "١٨٠٫٠٠" },
        { qty: "١×", name: "ليمون بالنعناع", meta: "كبير", amount: "٣٥٫٠٠" },
      ],
      status: "جهّز دلوقتي",
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
      { icon: Package, title: "Inventory Control", description: "Stock updates as orders come in, so you know what's running low.", roadmap: true },
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
