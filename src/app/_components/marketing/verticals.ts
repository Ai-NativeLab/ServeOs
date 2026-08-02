import {
  QrCode, MessageCircle, CalendarCheck, Monitor, Package, ChartColumn,
  ScanBarcode, Layers, Globe, CalendarClock, ShieldCheck, Pill,
  Ruler, Scissors, Truck,
  type LucideIcon,
} from "lucide-react";
import type { Locale } from "@/shared/errors";

export const VERTICAL_IDS = ["restaurant", "retail", "pharmacy", "timber"] as const;
export type VerticalId = (typeof VERTICAL_IDS)[number];

/**
 * `roadmap` marks a feature the product does not ship yet, and the card renders a
 * "Soon" chip. Stock, batch/expiry, barcodes, variants and units of measure have no
 * schema in src/server — do not clear these flags until the domain exists.
 */
type Feature = { icon: LucideIcon; title: string; description: string; roadmap?: boolean };

/** One line on the hero ticket. `meta` is the trade-specific detail that carries the vertical. */
type TicketLine = { qty: string; name: string; meta: string; amount: string };

type VerticalCopy = {
  label: string;
  badge: string;
  headlineLead: string;
  subhead: string;
  features: Feature[];
  steps: { title: string; description: string }[];
  ticket: { ref: string; channel: string; lines: TicketLine[]; status: string; total: string };
};

export type VerticalDef = {
  id: VerticalId;
  /** Each vertical owns exactly one accent, all four already in the token set as chart-1/2/4/5. */
  accent: string;
  copy: Record<Locale, VerticalCopy>;
};

/** Shared across every vertical — the headline highlight is deliberately identical in all four. */
export const SHARED = {
  en: { headlineHighlight: "Create your own in 1 minute.", soon: "Soon" },
  ar: { headlineHighlight: "أنشئ موقعك في دقيقة واحدة.", soon: "قريبًا" },
} satisfies Record<Locale, { headlineHighlight: string; soon: string }>;

const restaurant: VerticalDef = {
  id: "restaurant",
  accent: "#F0522B",
  copy: {
    en: {
      label: "Restaurant",
      badge: "QR menu · WhatsApp · Web ordering",
      headlineLead: "No restaurant website?",
      subhead:
        "Your menu online, orders everywhere — customers order by scanning a table QR, messaging WhatsApp, or your own ordering page. No app to install, and it all lands in one dashboard.",
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
    ar: {
      label: "مطاعم",
      badge: "قائمة QR · واتساب · طلب عبر الويب",
      headlineLead: "ليس لديك موقع لمطعمك؟",
      subhead:
        "قائمتك أونلاين وطلباتك في كل مكان — يطلب عملاؤك بمسح رمز QR على الطاولة، أو عبر واتساب، أو من صفحة الطلب الخاصة بك. دون أي تطبيق، وكل شيء يصل إلى لوحة تحكم واحدة.",
      features: [
        { icon: QrCode, title: "قائمة وطلب عبر QR", description: "كل طاولة تحصل على قائمة يتصفحها العملاء ويطلبون منها في ثوانٍ." },
        { icon: MessageCircle, title: "الطلب عبر واتساب", description: "دون تطبيق — يطلب العملاء مباشرة من محادثة مفتوحة لديهم بالفعل." },
        { icon: CalendarCheck, title: "حجز الطاولات", description: "استقبل الحجوزات دون انشغال الهاتف طوال الخدمة.", roadmap: true },
        { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للطلبات أونلاين والمبيعات داخل المطعم — دون مطابقة يدوية." },
        { icon: Package, title: "إدارة المخزون", description: "يتحدث المخزون مع كل طلب، فتعرف ما الذي أوشك على النفاد.", roadmap: true },
        { icon: ChartColumn, title: "تحليلات مباشرة", description: "شاهد ما الذي يُباع، ومتى، وأين — لحظة بلحظة." },
      ],
      steps: [
        { title: "أنشئ قائمتك", description: "الأصناف والمنتجات والصور — بالعربية والإنجليزية." },
        { title: "يطلب عملاؤك", description: "رمز QR على الطاولة، أو واتساب، أو رابط الطلب الخاص بك." },
        { title: "يصل كل شيء إلى لوحتك", description: "الطلبات ونقطة البيع والمخزون تتحدث معًا." },
      ],
      ticket: {
        ref: "طاولة ٤",
        channel: "في المطعم · QR",
        lines: [
          { qty: "٢×", name: "طبق شاورما", meta: "ثوم إضافي، دون مخلل", amount: "١٨٠٫٠٠" },
          { qty: "١×", name: "ليمون بالنعناع", meta: "كبير", amount: "٣٥٫٠٠" },
        ],
        status: "ابدأ التحضير",
        total: "٢١٥٫٠٠",
      },
    },
  },
};

const retail: VerticalDef = {
  id: "retail",
  accent: "#2DD4C4",
  copy: {
    en: {
      label: "Retail",
      badge: "Barcode · Storefront · Counter",
      headlineLead: "No shop website?",
      subhead:
        "Your catalogue online, your counter in sync — customers buy in the shop, from a barcode scan, or from your own storefront. Stock, sales, and receipts land in one dashboard.",
      features: [
        { icon: ScanBarcode, title: "Barcode Checkout", description: "Scan, ring, done — the counter keeps up with a queue.", roadmap: true },
        { icon: Layers, title: "Variants", description: "Size, colour, and pack — priced and counted separately.", roadmap: true },
        { icon: Globe, title: "Online Storefront", description: "The same catalogue your shop sells from, open to the web." },
        { icon: Monitor, title: "Point of Sale", description: "One system for the till and the web — nothing to reconcile by hand." },
        { icon: Package, title: "Stock Control", description: "Every sale moves stock, so the shelf and the screen agree.", roadmap: true },
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
    ar: {
      label: "متاجر",
      badge: "باركود · متجر إلكتروني · كاونتر",
      headlineLead: "ليس لديك موقع لمتجرك؟",
      subhead:
        "كتالوجك أونلاين وكاونترك متزامن — يشتري عملاؤك من المتجر، أو بمسح الباركود، أو من متجرك الإلكتروني. المخزون والمبيعات والفواتير تصل إلى لوحة تحكم واحدة.",
      features: [
        { icon: ScanBarcode, title: "الدفع بالباركود", description: "امسح، وسجّل، وانتهِ — كاونتر يواكب الطابور.", roadmap: true },
        { icon: Layers, title: "الأنواع والمقاسات", description: "المقاس واللون والعبوة — بسعر ومخزون مستقل لكل منها.", roadmap: true },
        { icon: Globe, title: "متجر إلكتروني", description: "نفس الكتالوج الذي يبيع منه متجرك، متاح على الويب." },
        { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للكاونتر والويب — دون مطابقة يدوية." },
        { icon: Package, title: "إدارة المخزون", description: "كل عملية بيع تحرّك المخزون، فيتطابق الرف مع الشاشة.", roadmap: true },
        { icon: ChartColumn, title: "تحليلات مباشرة", description: "شاهد ما الذي يُباع، ومتى، وفي أي فرع — لحظة بلحظة." },
      ],
      steps: [
        { title: "أنشئ كتالوجك", description: "المنتجات والمقاسات والباركود — بالعربية والإنجليزية." },
        { title: "يشتري عملاؤك", description: "من الكاونتر، أو بالمسح، أو من رابط متجرك." },
        { title: "يصل كل شيء إلى لوحتك", description: "المبيعات والمخزون والفواتير تتحدث معًا." },
      ],
      ticket: {
        ref: "بيع #١٠٤٢",
        channel: "كاونتر · باركود",
        lines: [
          { qty: "١×", name: "تيشيرت قطن", meta: "M · رملي · ٨٩٠١٢٣٤٥٦٧", amount: "١٢٠٫٠٠" },
          { qty: "٢×", name: "جوارب، عبوة ٣", meta: "٨٩٠٤٤٤٥١٢٠", amount: "٩٠٫٠٠" },
        ],
        status: "جاهز للدفع",
        total: "٢١٠٫٠٠",
      },
    },
  },
};

const pharmacy: VerticalDef = {
  id: "pharmacy",
  accent: "#38D08C",
  copy: {
    en: {
      label: "Pharmacy",
      badge: "Batches · Expiry · Prescriptions",
      headlineLead: "No pharmacy website?",
      subhead:
        "Your shelf online, your counter compliant — sell over-the-counter lines from a storefront, handle prescriptions at the counter, and never sell an expired box. One dashboard for stock, batches, and sales.",
      features: [
        { icon: CalendarClock, title: "Batch & Expiry", description: "Every box carries its batch and expiry date — the counter blocks what's out of date.", roadmap: true },
        { icon: ShieldCheck, title: "Prescription Handling", description: "Flag Rx-only and controlled lines so they never leave the counter unchecked.", roadmap: true },
        { icon: Pill, title: "Generic Substitutes", description: "Offer the equivalent when the brand is out of stock.", roadmap: true },
        { icon: Monitor, title: "Point of Sale", description: "One system for the counter and the web — nothing to reconcile by hand." },
        { icon: Package, title: "Stock Control", description: "Every sale moves stock, so the shelf and the screen agree.", roadmap: true },
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
    ar: {
      label: "صيدليات",
      badge: "تشغيلات · صلاحية · وصفات",
      headlineLead: "ليس لديك موقع لصيدليتك؟",
      subhead:
        "رفوفك أونلاين وكاونترك ملتزم — بِع المنتجات التي لا تحتاج وصفة من متجرك، واصرف الوصفات على الكاونتر، ولا تبع علبة منتهية الصلاحية أبدًا. لوحة واحدة للمخزون والتشغيلات والمبيعات.",
      features: [
        { icon: CalendarClock, title: "التشغيلة والصلاحية", description: "كل علبة تحمل رقم تشغيلتها وتاريخ صلاحيتها — والكاونتر يمنع المنتهي.", roadmap: true },
        { icon: ShieldCheck, title: "صرف الوصفات", description: "ميّز الأدوية التي تحتاج وصفة أو رقابة حتى لا تُصرف دون تحقق.", roadmap: true },
        { icon: Pill, title: "البدائل الجنيسة", description: "اعرض البديل المكافئ عند نفاد الصنف التجاري.", roadmap: true },
        { icon: Monitor, title: "نقطة البيع", description: "نظام واحد للكاونتر والويب — دون مطابقة يدوية." },
        { icon: Package, title: "إدارة المخزون", description: "كل عملية بيع تحرّك المخزون، فيتطابق الرف مع الشاشة.", roadmap: true },
        { icon: ChartColumn, title: "تحليلات مباشرة", description: "شاهد ما الذي يتحرك، وما الذي يقترب من الانتهاء، وفي أي فرع." },
      ],
      steps: [
        { title: "جهّز رفوفك", description: "المنتجات والتشغيلات وتواريخ الصلاحية — بالعربية والإنجليزية." },
        { title: "اخدم الكاونتر", description: "مبيعات دون وصفة، ووصفات طبية، وبدائل." },
        { title: "يصل كل شيء إلى لوحتك", description: "المبيعات والمخزون والتشغيلات المنتهية تتحدث معًا." },
      ],
      ticket: {
        ref: "طلب #٧٧٦",
        channel: "كاونتر · وصفة",
        lines: [
          { qty: "٢×", name: "باراسيتامول ٥٠٠ ملغ", meta: "تشغيلة B-2291 · تنتهي ٠٤/٢٧", amount: "٢٤٫٠٠" },
          { qty: "١×", name: "أموكسيسيلين ٢٥٠ ملغ", meta: "يحتاج وصفة · تم التحقق", amount: "٦٠٫٠٠" },
        ],
        status: "بانتظار الصيدلي",
        total: "٨٤٫٠٠",
      },
    },
  },
};

const timber: VerticalDef = {
  id: "timber",
  accent: "#E8A33D",
  copy: {
    en: {
      label: "Timber",
      badge: "Sold by dimension · Cut to order · Delivery",
      headlineLead: "No timber yard website?",
      subhead:
        "Your yard online, your cut list in sync — customers order boards by dimension, you price by the cubic metre, and every cut, offcut, and delivery lands in one dashboard.",
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
    ar: {
      label: "أخشاب",
      badge: "بيع بالأبعاد · قص حسب الطلب · توصيل",
      headlineLead: "ليس لديك موقع لمستودع الأخشاب؟",
      subhead:
        "مستودعك أونلاين وقائمة القص متزامنة — يطلب عملاؤك الألواح بالأبعاد، وتسعّر بالمتر المكعب، وكل قصّة وتوصيلة تصل إلى لوحة تحكم واحدة.",
      features: [
        { icon: Ruler, title: "البيع بالأبعاد", description: "سعّر بالمتر المكعب أو الطولي أو باللوح — لا بالقطعة.", roadmap: true },
        { icon: Scissors, title: "قوائم القص", description: "الطلب يحمل قائمة القص، فيعرف المنشار قبل وصول العميل.", roadmap: true },
        { icon: Truck, title: "التوصيل والاستلام", description: "استلام من المستودع أو توصيل للموقع، بسعر حسب المنطقة." },
        { icon: Monitor, title: "نقطة البيع", description: "نظام واحد لكاونتر المستودع والويب — دون مطابقة يدوية." },
        { icon: Package, title: "إدارة المخزون", description: "كل قصّة تحرّك المخزون، فيتطابق الرف مع الشاشة.", roadmap: true },
        { icon: ChartColumn, title: "تحليلات مباشرة", description: "شاهد أي الأنواع والمقاسات تتحرك، وما الراكد في الرف." },
      ],
      steps: [
        { title: "أدرج مخزونك", description: "الأنواع والدرجات والأبعاد — بسعر لكل وحدة قياس." },
        { title: "يطلب عملاؤك", description: "بالأبعاد، مقصوصًا على المقاس، للاستلام أو التوصيل." },
        { title: "يصل كل شيء إلى لوحتك", description: "قوائم القص والمخزون والتوصيلات تتحدث معًا." },
      ],
      ticket: {
        ref: "أمر #٣١٨",
        channel: "مستودع · قص حسب الطلب",
        lines: [
          { qty: "٢×", name: "لوح بلوط", meta: "٢٤٠٠ × ٣٠٠ × ١٨ مم · ٠٫٠٢٦ م٣", amount: "٤١٠٫٠٠" },
          { qty: "١٢×", name: "عارضة صنوبر", meta: "٢٫٤ م · ٢٨٫٨ متر طولي", amount: "١٩٠٫٠٠" },
        ],
        status: "قيد القص",
        total: "٦٠٠٫٠٠",
      },
    },
  },
};

export const verticals: Record<VerticalId, VerticalDef> = { restaurant, retail, pharmacy, timber };
