import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });
import { and, eq, isNull } from "drizzle-orm";
import { DEMO_IMAGES } from "../src/server/demo/images";

/**
 * Seeds one public demo tenant per vertical — demo-restaurant, demo-retail,
 * demo-pharmacy, demo-timber — matching the slugs `getDemoEntry()` builds in
 * src/server/demo/entry.ts (`https://demo-<trade>.<ROOT_DOMAIN>`). These are
 * the tenants the marketing page's screenshot pipeline (capture-marketing-
 * shots.ts) signs into, so each one carries a full catalog and enough placed
 * orders that its dashboard Home shows real numbers, not an empty state.
 *
 * Idempotent: re-running reuses each tenant/branch and only replaces the
 * catalog when it is missing or incomplete (mirrors scripts/seed.ts and
 * scripts/seed-retail-showcase.ts); orders are seeded once and never
 * re-created once any exist.
 *
 *   npx tsx scripts/seed-demo-tenants.ts
 */

const {
  restaurant: { GRILL_PLATTER, MEZZE_SPREAD, RICE_SIDES, DRINKS_TRAY, LEMONADE, DESSERTS, RESTAURANT_COVER, RESTAURANT_LOGO },
  retail: { GLOVED_HANDS, SOFT_DRINKS, DAIRY_EGGS, HOUSEHOLD_CLEANING },
  pharmacy: { MEDICINES, PERSONAL_CARE, BABY_CARE, SUPPLEMENTS, PHARMACY_COVER, PHARMACY_LOGO },
  timber: { SHEET_GOODS, PLANED_TIMBER, MOULDINGS, FIXINGS, HINGES, HANDLES, TIMBER_COVER, TIMBER_LOGO },
} = DEMO_IMAGES;

const SPICE_LEVEL: SeedModifierGroup = {
  nameEn: "Spice level", nameAr: "درجة الحرارة", required: true, minSelections: 1, maxSelections: 1,
  options: [
    { nameEn: "Mild", nameAr: "خفيف", isDefault: true },
    { nameEn: "Medium", nameAr: "وسط" },
    { nameEn: "Hot", nameAr: "حار" },
  ],
};

const GRILL_SIDES: SeedModifierGroup = {
  nameEn: "Choose a side", nameAr: "اختر طبقًا جانبيًا", required: false, minSelections: 0, maxSelections: 1,
  options: [
    { nameEn: "Rice with vermicelli", nameAr: "أرز بالشعيرية", isDefault: true },
    { nameEn: "Freekeh", nameAr: "فريكة", priceDelta: "10" },
    { nameEn: "Grilled vegetables", nameAr: "خضار مشوية", priceDelta: "15" },
  ],
};

const GRILL_EXTRAS: SeedModifierGroup = {
  nameEn: "Extras", nameAr: "إضافات", required: false, minSelections: 0, maxSelections: 3,
  options: [
    { nameEn: "Extra tahina", nameAr: "طحينة إضافية", priceDelta: "10" },
    { nameEn: "Extra baladi bread", nameAr: "عيش بلدي إضافي", priceDelta: "5" },
    { nameEn: "Grilled onions", nameAr: "بصل مشوي", priceDelta: "10" },
  ],
};

type Trade = "restaurant" | "retail" | "pharmacy" | "timber";

type SeedVariant = { nameEn: string; nameAr: string; price: string; stock: number | null };

/**
 * Restaurant-only. `modifiers` capability is true for restaurant and false for
 * every other vertical (src/server/verticals/registry.ts), and
 * upsertModifierGroup enforces that — so attaching one to a retail product
 * throws rather than silently no-oping.
 */
type SeedModifierGroup = {
  nameEn: string;
  nameAr: string;
  required: boolean;
  minSelections: number;
  maxSelections: number;
  options: { nameEn: string; nameAr: string; priceDelta?: string; isDefault?: boolean }[];
};

type SeedProduct = {
  nameEn: string;
  nameAr: string;
  /** Both descriptions are REQUIRED, not optional. They used to be optional and
   *  only 20 of 89 products carried one, so most product sheets rendered with a
   *  name and a price and nothing else. Making them mandatory means the
   *  compiler, not a reviewer, catches the next product added without copy. */
  descEn: string;
  descAr: string;
  price: string;
  img: string;
  featured?: boolean;
  trackStock?: boolean;
  stockQuantity?: number | null;
  requiresPrescription?: boolean;
  /** P4 dimensional pricing (timber): basePrice above is reinterpreted as price-per-unit-of-measure. */
  uom?: "m" | "m2";
  /** Retail, pharmacy and timber — the verticals whose `variants` capability is true. */
  variants?: SeedVariant[];
  /** Restaurant only, see SeedModifierGroup. */
  modifiers?: SeedModifierGroup[];
};
type SeedCategory = { nameEn: string; nameAr: string; img: string; products: SeedProduct[] };

type DeliveryAreaSeed = { nameEn: string; nameAr: string; fee: string; minOrder: string; eta: number };

type TenantSeedConfig = {
  trade: Trade;
  slug: string;
  name: string;
  tagline: string;
  taglineAr: string;
  /** Stored in the `cuisine` column — rendered per-vertical as "Store type"/"Yard type"/"Cuisine". */
  businessType: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  coverImg: string;
  logoImg: string;
  areas: DeliveryAreaSeed[];
  catalog: SeedCategory[];
  /**
   * Simple, each-priced, non-Rx, non-variant products safe to run through
   * placeOrder — and, since modifiers were added, products with no REQUIRED
   * modifier group either. Checked by assertOrderable at startup so the
   * mismatch surfaces as a named config error rather than as an opaque
   * "required modifier missing" from deep inside order validation.
   */
  orderableNames: string[];
};

// ── demo-restaurant: Zeytoun Kitchen ────────────────────────────────────────
const RESTAURANT: TenantSeedConfig = {
  trade: "restaurant",
  slug: "demo-restaurant",
  name: "Zeytoun Kitchen",
  tagline: "Egyptian home-style grills & mezze",
  taglineAr: "مشويات ومقبلات بيتية مصرية",
  businessType: "Egyptian grill house",
  ownerName: "Mona Fathy",
  ownerEmail: "owner@demo-restaurant.serveos.com",
  ownerPassword: "demo1234",
  coverImg: RESTAURANT_COVER,
  logoImg: RESTAURANT_LOGO,
  areas: [
    { nameEn: "Dokki", nameAr: "الدقي", fee: "20", minOrder: "80", eta: 30 },
    { nameEn: "Mohandessin", nameAr: "المهندسين", fee: "30", minOrder: "100", eta: 40 },
  ],
  catalog: [
    { nameEn: "Grills", nameAr: "مشويات", img: GRILL_PLATTER, products: [
      { nameEn: "Grilled Chicken Half", nameAr: "نصف فرخة مشوية",
        descEn: "Charcoal-grilled over open flame, lemon-garlic marinade, served with tahina and baladi bread.",
        descAr: "مشوية على الفحم، متبّلة بالليمون والثوم، وتُقدَّم مع الطحينة والعيش البلدي.",
        price: "120", img: GRILL_PLATTER, featured: true,
        modifiers: [SPICE_LEVEL, GRILL_SIDES, GRILL_EXTRAS] },
      { nameEn: "Kofta Skewer", nameAr: "كفتة مشوية",
        descEn: "Hand-minced beef with parsley and onion, pressed onto skewers and grilled over charcoal.",
        descAr: "لحم بقري مفروم يدويًا بالبقدونس والبصل، يُشكَّل على أسياخ ويُشوى على الفحم.",
        price: "110", img: GRILL_PLATTER, featured: true,
        modifiers: [SPICE_LEVEL, GRILL_SIDES, GRILL_EXTRAS] },
      { nameEn: "Lamb Chops", nameAr: "ريش ضاني",
        descEn: "Four marinated lamb chops, grilled to order and finished with sea salt.",
        descAr: "أربع قطع ريش ضاني متبّلة، تُشوى عند الطلب وتُرش بملح البحر.",
        price: "220", img: GRILL_PLATTER,
        modifiers: [SPICE_LEVEL, GRILL_SIDES] },
      { nameEn: "Mixed Grill Platter", nameAr: "مشويات مشكلة",
        descEn: "Kofta, shish tawook and lamb kebab on one board — enough for two.",
        descAr: "كفتة وشيش طاووق وكباب ضاني على صينية واحدة — تكفي شخصين.",
        price: "260", img: GRILL_PLATTER,
        modifiers: [SPICE_LEVEL, GRILL_SIDES, GRILL_EXTRAS] },
      // Eight grills, not four: the POS take-order grid is four tiles wide, so
      // a four-item category renders as one row with a third of the till left
      // as bare panel — and that screenshot is what the marketing tour shows.
      // A demo catalog thin enough to look empty makes the product look empty.
      { nameEn: "Shish Tawook", nameAr: "شيش طاووق",
        descEn: "Chicken breast marinated overnight in yoghurt, garlic and lemon, then skewered.",
        descAr: "صدور دجاج منقوعة ليلة كاملة في الزبادي والثوم والليمون، ثم تُشوى على أسياخ.",
        price: "95", img: GRILL_PLATTER,
        modifiers: [SPICE_LEVEL, GRILL_SIDES, GRILL_EXTRAS] },
      { nameEn: "Kebab Halabi", nameAr: "كباب حلبي",
        descEn: "Minced lamb with Aleppo pepper and pine nuts, chargrilled on flat skewers.",
        descAr: "لحم ضاني مفروم بالفلفل الحلبي والصنوبر، مشوي على أسياخ عريضة.",
        price: "200", img: GRILL_PLATTER,
        modifiers: [SPICE_LEVEL, GRILL_SIDES] },
      { nameEn: "Grilled Quail", nameAr: "سمان مشوي",
        descEn: "Two whole quail, butterflied and grilled with cumin and lemon.",
        descAr: "سمانتان مفتوحتان ومشويتان بالكمون والليمون.",
        price: "180", img: GRILL_PLATTER,
        modifiers: [SPICE_LEVEL, GRILL_SIDES] },
      { nameEn: "Chicken Wings", nameAr: "أجنحة دجاج",
        descEn: "Six wings in garlic and lemon, grilled crisp at the edges.",
        descAr: "ستة أجنحة بالثوم والليمون، مشوية حتى تصبح مقرمشة الأطراف.",
        price: "85", img: GRILL_PLATTER,
        modifiers: [SPICE_LEVEL, GRILL_EXTRAS] },
    ] },
    { nameEn: "Mezze & Salads", nameAr: "مقبلات وسلطات", img: MEZZE_SPREAD, products: [
      { nameEn: "Hummus", nameAr: "حمص",
        descEn: "Chickpeas blended with tahina and lemon, finished with olive oil and cumin.",
        descAr: "حمص مخلوط بالطحينة والليمون، مع زيت زيتون وكمون.",
        price: "45", img: MEZZE_SPREAD, featured: true },
      { nameEn: "Baba Ghanoush", nameAr: "بابا غنوج",
        descEn: "Eggplant smoked over flame, mashed with tahina, garlic and lemon.",
        descAr: "باذنجان مدخّن على النار، مهروس بالطحينة والثوم والليمون.",
        price: "45", img: MEZZE_SPREAD },
      { nameEn: "Fattoush Salad", nameAr: "سلطة فتوش",
        descEn: "Crisp vegetables and toasted bread in a sumac and pomegranate dressing.",
        descAr: "خضار طازجة وخبز محمّص مع صلصة السماق ودبس الرمان.",
        price: "55", img: MEZZE_SPREAD },
      { nameEn: "Baladi Salad", nameAr: "سلطة بلدي",
        descEn: "Tomato, cucumber, onion and parsley, chopped fine and dressed simply.",
        descAr: "طماطم وخيار وبصل وبقدونس، مفرومة ناعمة بتتبيلة بسيطة.",
        price: "35", img: MEZZE_SPREAD },
    ] },
    { nameEn: "Rice & Sides", nameAr: "أرز وأطباق جانبية", img: RICE_SIDES, products: [
      { nameEn: "Rice with Vermicelli", nameAr: "أرز بالشعيرية",
        descEn: "Egyptian everyday rice, toasted vermicelli stirred through.",
        descAr: "أرز مصري يومي مع شعيرية محمّصة.",
        price: "30", img: RICE_SIDES },
      { nameEn: "Freekeh", nameAr: "فريكة",
        descEn: "Green wheat simmered in chicken stock with whole spices.",
        descAr: "قمح أخضر مطبوخ في مرقة الدجاج مع البهارات الكاملة.",
        price: "40", img: RICE_SIDES },
      { nameEn: "Grilled Vegetables", nameAr: "خضار مشكلة مشوية",
        descEn: "Peppers, courgette, onion and tomato from the same charcoal grill.",
        descAr: "فلفل وكوسة وبصل وطماطم من نفس شواية الفحم.",
        price: "45", img: RICE_SIDES },
    ] },
    { nameEn: "Drinks", nameAr: "مشروبات", img: DRINKS_TRAY, products: [
      { nameEn: "Hibiscus Tea", nameAr: "كركديه",
        descEn: "Cold-steeped hibiscus, lightly sweetened. Served chilled.",
        descAr: "كركديه منقوع على البارد، محلّى قليلًا ويُقدَّم مثلجًا.",
        price: "25", img: DRINKS_TRAY },
      { nameEn: "Fresh Lemon & Mint", nameAr: "ليمون بالنعناع",
        descEn: "Lemons pressed to order and blended with fresh mint.",
        descAr: "ليمون يُعصر عند الطلب ويُخلط بالنعناع الطازج.",
        price: "30", img: LEMONADE },
      { nameEn: "Soft Drink", nameAr: "مياه غازية",
        descEn: "Chilled canned soft drink — ask for the day's selection.",
        descAr: "مشروب غازي مثلج — اسأل عن المتوفر اليوم.",
        price: "20", img: DRINKS_TRAY },
    ] },
    { nameEn: "Desserts", nameAr: "حلويات", img: DESSERTS, products: [
      { nameEn: "Om Ali", nameAr: "أم علي",
        descEn: "Baked pastry pudding with milk, cream and toasted nuts. Served hot.",
        descAr: "حلوى مخبوزة باللبن والقشطة والمكسرات المحمّصة، تُقدَّم ساخنة.",
        price: "55", img: DESSERTS, featured: true },
      { nameEn: "Kunafa", nameAr: "كنافة",
        descEn: "Shredded pastry over sweet cheese, baked and soaked in syrup.",
        descAr: "كنافة ناعمة فوق جبن حلو، تُخبز وتُسقى بالشربات.",
        // Shares Om Ali's photo deliberately. The verified pool's other dessert
        // shots are Italian (panna cotta, cannoli, tiramisù) and putting one of
        // those on kunafa would be a worse lie than a repeated photo.
        price: "60", img: DESSERTS },
    ] },
  ],
  // No grills here: every one of them now carries a REQUIRED spice-level
  // group, and placeOrder rejects a line that omits a required modifier
  // ("required modifier missing"). The seeded orders exist to give the
  // dashboard real numbers, not to exercise modifier selection, so they use
  // the plain products. assertOrderable below enforces this.
  orderableNames: ["Hummus", "Fattoush Salad", "Rice with Vermicelli", "Hibiscus Tea", "Om Ali"],
};

// ── demo-retail: Baraka Mini Market ─────────────────────────────────────────
const RETAIL: TenantSeedConfig = {
  trade: "retail",
  slug: "demo-retail",
  name: "Baraka Mini Market",
  tagline: "Your neighborhood grocery, delivered same day",
  taglineAr: "سوبر ماركت الحي، يوصل لك في نفس اليوم",
  businessType: "Grocery & convenience",
  ownerName: "Hassan Ibrahim",
  ownerEmail: "owner@demo-retail.serveos.com",
  ownerPassword: "demo1234",
  coverImg: GLOVED_HANDS,
  logoImg: DAIRY_EGGS,
  areas: [
    { nameEn: "Heliopolis", nameAr: "مصر الجديدة", fee: "15", minOrder: "50", eta: 25 },
  ],
  catalog: [
    // NOTE: this aisle used to point every product at a photo of a computer
    // screen. See the photography block at the top of this file.
    { nameEn: "Snacks", nameAr: "سناكس", img: GLOVED_HANDS, products: [
      { nameEn: "Potato Chips Family Pack", nameAr: "شيبسي عبوة كبيرة",
        descEn: "Sharing bag, 165g. Salted or chilli — pick below.",
        descAr: "كيس عائلي ١٦٥ جم. مملح أو شطة — اختر من الأسفل.",
        price: "45", img: GLOVED_HANDS, featured: true,
        variants: [
          { nameEn: "Salted", nameAr: "مملح", price: "45", stock: 60 },
          { nameEn: "Chilli", nameAr: "شطة", price: "45", stock: 45 },
        ] },
      { nameEn: "Chocolate Bar", nameAr: "شيكولاتة",
        descEn: "Milk chocolate bar, 80g.",
        descAr: "لوح شيكولاتة بالحليب، ٨٠ جم.",
        price: "25", img: GLOVED_HANDS },
      { nameEn: "Biscuits Pack", nameAr: "بسكويت",
        descEn: "Tea biscuits, twin-wrapped roll.",
        descAr: "بسكويت شاي، لفة مزدوجة.",
        price: "20", img: GLOVED_HANDS },
      { nameEn: "Salted Peanuts", nameAr: "فول سوداني مملح",
        descEn: "Roasted and salted, 200g bag.",
        descAr: "محمّص ومملح، كيس ٢٠٠ جم.",
        price: "30", img: GLOVED_HANDS, trackStock: true, stockQuantity: 0 },
    ] },
    { nameEn: "Beverages", nameAr: "مشروبات", img: SOFT_DRINKS, products: [
      { nameEn: "Bottled Water 6-pack", nameAr: "مياه معدنية ٦ عبوات",
        descEn: "Six 1.5L bottles, shrink-wrapped.",
        descAr: "ست زجاجات ١.٥ لتر بغلاف واحد.",
        price: "30", img: SOFT_DRINKS, featured: true },
      { nameEn: "Soft Drink 1.5L", nameAr: "مشروب غازي ١.٥ لتر",
        descEn: "Large bottle, chilled in store.",
        descAr: "زجاجة كبيرة، مبرّدة في المحل.",
        price: "25", img: SOFT_DRINKS,
        variants: [
          { nameEn: "Cola", nameAr: "كولا", price: "25", stock: 50 },
          { nameEn: "Orange", nameAr: "برتقال", price: "25", stock: 30 },
          { nameEn: "Lemon", nameAr: "ليمون", price: "25", stock: 20 },
        ] },
      { nameEn: "Juice Carton", nameAr: "عصير",
        descEn: "One litre, no added sugar.",
        descAr: "لتر واحد، بدون سكر مضاف.",
        price: "22", img: SOFT_DRINKS,
        variants: [
          { nameEn: "Mango", nameAr: "مانجو", price: "22", stock: 24 },
          { nameEn: "Guava", nameAr: "جوافة", price: "22", stock: 18 },
        ] },
    ] },
    { nameEn: "Dairy & Eggs", nameAr: "ألبان وبيض", img: DAIRY_EGGS, products: [
      { nameEn: "Milk 1L", nameAr: "لبن ١ لتر",
        descEn: "Pasteurised, delivered daily. Keep refrigerated.",
        descAr: "مبستر ويصل يوميًا. يُحفظ في الثلاجة.",
        price: "35", img: DAIRY_EGGS,
        variants: [
          { nameEn: "Full Fat", nameAr: "كامل الدسم", price: "35", stock: 40 },
          { nameEn: "Low Fat", nameAr: "قليل الدسم", price: "35", stock: 25 },
        ] },
      { nameEn: "Eggs Tray 30pc", nameAr: "كرتونة بيض ٣٠ بيضة",
        descEn: "Thirty eggs, farm-packed this week.",
        descAr: "ثلاثون بيضة، معبّأة من المزرعة هذا الأسبوع.",
        price: "110", img: DAIRY_EGGS, featured: true },
      { nameEn: "White Cheese 500g", nameAr: "جبنة بيضاء ٥٠٠ جم",
        descEn: "Brined white cheese, sold by the tub.",
        descAr: "جبنة بيضاء في محلول ملحي، تُباع بالعبوة.",
        price: "90", img: DAIRY_EGGS,
        variants: [
          { nameEn: "Low salt", nameAr: "قليلة الملح", price: "90", stock: 15 },
          { nameEn: "Full salt", nameAr: "كاملة الملح", price: "90", stock: 22 },
        ] },
    ] },
    { nameEn: "Household", nameAr: "منزلية", img: HOUSEHOLD_CLEANING, products: [
      { nameEn: "Dish Soap", nameAr: "سائل غسيل الأطباق",
        descEn: "Concentrated, 750ml bottle.",
        descAr: "مركّز، زجاجة ٧٥٠ مل.",
        price: "40", img: HOUSEHOLD_CLEANING },
      { nameEn: "Tissue Box", nameAr: "مناديل ورقية",
        descEn: "Two-ply facial tissues, 150 sheets.",
        descAr: "مناديل وجه بطبقتين، ١٥٠ منديلًا.",
        price: "25", img: HOUSEHOLD_CLEANING },
      { nameEn: "Laundry Detergent", nameAr: "مسحوق غسيل",
        descEn: "Automatic washing powder. Price shown is for the 3kg box.",
        descAr: "مسحوق غسيل أوتوماتيك. السعر المعروض لعبوة ٣ كجم.",
        price: "150", img: HOUSEHOLD_CLEANING,
        variants: [
          { nameEn: "1kg", nameAr: "١ كجم", price: "60", stock: 30 },
          { nameEn: "3kg", nameAr: "٣ كجم", price: "150", stock: 10 },
        ] },
      { nameEn: "Toothpaste", nameAr: "معجون أسنان",
        descEn: "Fluoride toothpaste, 100ml tube.",
        descAr: "معجون أسنان بالفلورايد، أنبوبة ١٠٠ مل.",
        price: "35", img: HOUSEHOLD_CLEANING },
    ] },
  ],
  orderableNames: ["Chocolate Bar", "Biscuits Pack", "Bottled Water 6-pack", "Juice Carton", "Tissue Box", "Toothpaste"],
};

// ── demo-pharmacy: El Salam Pharmacy ────────────────────────────────────────
const PHARMACY: TenantSeedConfig = {
  trade: "pharmacy",
  slug: "demo-pharmacy",
  name: "El Salam Pharmacy",
  tagline: "Nasr City's trusted neighborhood pharmacy",
  taglineAr: "صيدلية الحي الموثوقة في مدينة نصر",
  businessType: "Community pharmacy",
  ownerName: "Dr. Yara Mostafa",
  ownerEmail: "owner@demo-pharmacy.serveos.com",
  ownerPassword: "demo1234",
  coverImg: PHARMACY_COVER,
  logoImg: PHARMACY_LOGO,
  areas: [
    { nameEn: "Nasr City", nameAr: "مدينة نصر", fee: "15", minOrder: "60", eta: 25 },
  ],
  catalog: [
    { nameEn: "Medicines", nameAr: "أدوية", img: MEDICINES, products: [
      { nameEn: "Panadol Extra 24 Tabs", nameAr: "بانادول إكسترا ٢٤ قرص",
        descEn: "Paracetamol 500mg with caffeine. For headache and period pain. Read the leaflet before use.",
        descAr: "باراسيتامول ٥٠٠ مجم مع كافيين. لصداع وآلام الدورة. اقرأ النشرة قبل الاستخدام.",
        price: "25", img: MEDICINES, featured: true,
        variants: [
          { nameEn: "24 tablets", nameAr: "٢٤ قرص", price: "25", stock: 60 },
          { nameEn: "48 tablets", nameAr: "٤٨ قرص", price: "45", stock: 25 },
        ] },
      { nameEn: "Augmentin 1g", nameAr: "أوجمنتين ١ جرام",
        descEn: "Amoxicillin and clavulanic acid. Prescription required — upload it at checkout and our pharmacist will review.",
        descAr: "أموكسيسيلين وحمض كلافولانيك. يتطلب روشتة — ارفعها عند إتمام الطلب ليراجعها الصيدلي.",
        price: "85", img: MEDICINES, requiresPrescription: true },
      { nameEn: "Vitamin C 1000mg", nameAr: "فيتامين سي ١٠٠٠ مجم",
        descEn: "Effervescent tablets, orange flavour. One daily in water.",
        descAr: "أقراص فوارة بنكهة البرتقال. قرص واحد يوميًا في الماء.",
        price: "60", img: MEDICINES,
        variants: [
          { nameEn: "10 tablets", nameAr: "١٠ أقراص", price: "60", stock: 40 },
          { nameEn: "20 tablets", nameAr: "٢٠ قرص", price: "105", stock: 18 },
        ] },
      { nameEn: "Antacid Syrup", nameAr: "شراب مضاد للحموضة",
        descEn: "Relieves heartburn and indigestion. 120ml bottle with dosing cup.",
        descAr: "يخفف الحموضة وعسر الهضم. زجاجة ١٢٠ مل مع كوب القياس.",
        price: "35", img: MEDICINES },
      { nameEn: "Cough Syrup", nameAr: "شراب للسعال",
        descEn: "Soothes dry cough. Not for children under six.",
        descAr: "يهدئ الكحة الجافة. غير مناسب للأطفال أقل من ست سنوات.",
        price: "40", img: MEDICINES },
    ] },
    { nameEn: "Personal Care", nameAr: "العناية الشخصية", img: PERSONAL_CARE, products: [
      { nameEn: "Hand Sanitizer 500ml", nameAr: "معقم يدين ٥٠٠ مل",
        descEn: "70% alcohol gel with pump top.",
        descAr: "جل بنسبة كحول ٧٠٪ مع مضخة.",
        price: "45", img: PERSONAL_CARE, featured: true },
      { nameEn: "Sunscreen SPF50", nameAr: "واقي شمس ٥٠",
        descEn: "Broad-spectrum, water-resistant. Reapply every two hours.",
        descAr: "حماية واسعة المدى ومقاوم للماء. يُعاد وضعه كل ساعتين.",
        price: "180", img: PERSONAL_CARE },
      { nameEn: "Anti-Dandruff Shampoo", nameAr: "شامبو ضد القشرة",
        descEn: "Ketoconazole shampoo. Twice weekly for four weeks.",
        descAr: "شامبو بالكيتوكونازول. مرتين أسبوعيًا لمدة أربعة أسابيع.",
        price: "95", img: PERSONAL_CARE,
        variants: [
          { nameEn: "200ml", nameAr: "٢٠٠ مل", price: "95", stock: 20 },
          { nameEn: "400ml", nameAr: "٤٠٠ مل", price: "165", stock: 12 },
        ] },
      { nameEn: "Sensitive Toothpaste", nameAr: "معجون أسنان للأسنان الحساسة",
        descEn: "For sensitive teeth. Use twice daily.",
        descAr: "للأسنان الحساسة. يُستخدم مرتين يوميًا.",
        price: "55", img: PERSONAL_CARE },
    ] },
    { nameEn: "Baby Care", nameAr: "عناية الطفل", img: BABY_CARE, products: [
      { nameEn: "Diapers Size 4", nameAr: "حفاضات مقاس ٤",
        descEn: "For 9–14kg. Mega box of 68.",
        descAr: "لوزن ٩–١٤ كجم. عبوة كبيرة ٦٨ حفاضة.",
        price: "210", img: BABY_CARE, featured: true,
        variants: [
          { nameEn: "Size 3 (6–10kg)", nameAr: "مقاس ٣ (٦–١٠ كجم)", price: "195", stock: 14 },
          { nameEn: "Size 4 (9–14kg)", nameAr: "مقاس ٤ (٩–١٤ كجم)", price: "210", stock: 20 },
          { nameEn: "Size 5 (11–25kg)", nameAr: "مقاس ٥ (١١–٢٥ كجم)", price: "225", stock: 9 },
        ] },
      { nameEn: "Baby Formula 400g", nameAr: "حليب أطفال ٤٠٠ جم",
        descEn: "Stage 1, from birth to six months. Follow the tin's preparation instructions.",
        descAr: "المرحلة الأولى، من الولادة حتى ستة أشهر. اتبع تعليمات التحضير على العبوة.",
        price: "260", img: BABY_CARE },
      { nameEn: "Baby Wipes", nameAr: "مناديل مبللة للأطفال",
        descEn: "Fragrance-free, 72 wipes with a resealable lid.",
        descAr: "بدون عطر، ٧٢ منديلًا بغطاء قابل لإعادة الإغلاق.",
        price: "45", img: BABY_CARE },
      { nameEn: "Baby Lotion", nameAr: "لوشن للأطفال",
        descEn: "Light moisturiser for daily use after bathing.",
        descAr: "مرطب خفيف للاستخدام اليومي بعد الاستحمام.",
        price: "70", img: BABY_CARE },
    ] },
    { nameEn: "Vitamins & Supplements", nameAr: "فيتامينات ومكملات", img: SUPPLEMENTS, products: [
      { nameEn: "Multivitamin Adult", nameAr: "فيتامينات متعددة للبالغين",
        descEn: "One-a-day tablets, 30-day pack.",
        descAr: "قرص واحد يوميًا، عبوة تكفي ٣٠ يومًا.",
        price: "150", img: SUPPLEMENTS,
        variants: [
          { nameEn: "30 tablets", nameAr: "٣٠ قرص", price: "150", stock: 25 },
          { nameEn: "60 tablets", nameAr: "٦٠ قرص", price: "270", stock: 10 },
        ] },
      { nameEn: "Omega-3 Capsules", nameAr: "أوميجا ٣",
        descEn: "Fish oil, 1000mg per capsule. Take with food.",
        descAr: "زيت سمك، ١٠٠٠ مجم لكل كبسولة. يُؤخذ مع الطعام.",
        price: "220", img: SUPPLEMENTS, trackStock: true, stockQuantity: 0 },
    ] },
  ],
  orderableNames: ["Panadol Extra 24 Tabs", "Vitamin C 1000mg", "Hand Sanitizer 500ml", "Baby Wipes", "Multivitamin Adult"],
};

// ── demo-timber: Nile Timber Yard ───────────────────────────────────────────
const TIMBER: TenantSeedConfig = {
  trade: "timber",
  slug: "demo-timber",
  name: "Nile Timber Yard",
  tagline: "Sheikh Zayed's cut-to-size timber & sheet goods",
  taglineAr: "أخشاب وألواح مقاسات مخصوصة في الشيخ زايد",
  businessType: "Timber & sheet goods yard",
  ownerName: "Tarek Aboul-Fotouh",
  ownerEmail: "owner@demo-timber.serveos.com",
  ownerPassword: "demo1234",
  coverImg: TIMBER_COVER,
  logoImg: TIMBER_LOGO,
  areas: [
    { nameEn: "Sheikh Zayed", nameAr: "الشيخ زايد", fee: "50", minOrder: "300", eta: 90 },
  ],
  catalog: [
    // Dimensional products carry no variants: their price comes from the cut
    // dimensions entered at checkout (unitOfMeasure + P4 pricing), so a size
    // variant would be a second, contradictory source of the same number.
    { nameEn: "Sheet Goods", nameAr: "الألواح", img: SHEET_GOODS, products: [
      { nameEn: "MDF Board 18mm", nameAr: "لوح MDF ١٨ مم",
        descEn: "Priced per m² — enter length and width at checkout and we cut to size. Standard sheet 2440 × 1220mm.",
        descAr: "السعر بالمتر المربع — أدخل الطول والعرض عند إتمام الطلب ونقصه بالمقاس. اللوح القياسي ٢٤٤٠ × ١٢٢٠ مم.",
        price: "220", img: SHEET_GOODS, featured: true, uom: "m2" },
      { nameEn: "Plywood 12mm", nameAr: "أبلاكاش ١٢ مم",
        descEn: "Priced per m² — enter length and width at checkout. Marine-grade glue line.",
        descAr: "السعر بالمتر المربع — أدخل الطول والعرض عند إتمام الطلب. لاصق مقاوم للرطوبة.",
        price: "260", img: SHEET_GOODS, uom: "m2" },
      { nameEn: "Melamine Board White 16mm", nameAr: "لوح ميلامين أبيض ١٦ مم",
        descEn: "Priced per m² — enter length and width at checkout. Faced both sides, no edging included.",
        descAr: "السعر بالمتر المربع — أدخل الطول والعرض عند إتمام الطلب. مغطى من الوجهين، بدون شريط حواف.",
        price: "240", img: SHEET_GOODS, uom: "m2" },
      { nameEn: "HDF Board 6mm", nameAr: "لوح HDF ٦ مم",
        descEn: "Priced per m² — enter length and width at checkout. Suits cabinet backs and drawer bases.",
        descAr: "السعر بالمتر المربع — أدخل الطول والعرض عند إتمام الطلب. مناسب لظهور الدواليب وقيعان الأدراج.",
        price: "140", img: SHEET_GOODS, uom: "m2" },
    ] },
    { nameEn: "Planed Timber", nameAr: "الأخشاب المنجورة", img: PLANED_TIMBER, products: [
      { nameEn: "Pine Timber 2x4\"", nameAr: "خشب صنوبر ٢×٤ بوصة",
        descEn: "Priced per linear metre — enter length at checkout. Kiln-dried, planed all round.",
        descAr: "السعر بالمتر الطولي — أدخل الطول عند إتمام الطلب. مجفف بالفرن ومنجور من كل الجوانب.",
        price: "45", img: PLANED_TIMBER, featured: true, uom: "m" },
      { nameEn: "Meranti Timber 1x6\"", nameAr: "خشب ميرانتي ١×٦ بوصة",
        descEn: "Priced per linear metre — enter length at checkout. Stable hardwood for doors and frames.",
        descAr: "السعر بالمتر الطولي — أدخل الطول عند إتمام الطلب. خشب صلب ثابت للأبواب والحلوق.",
        price: "65", img: PLANED_TIMBER, uom: "m" },
      { nameEn: "Beech Timber 1x2\"", nameAr: "خشب زان ١×٢ بوصة",
        descEn: "Priced per linear metre — enter length at checkout. Close grain, takes a clean finish.",
        descAr: "السعر بالمتر الطولي — أدخل الطول عند إتمام الطلب. حبيبات ناعمة وتشطيب نظيف.",
        price: "38", img: PLANED_TIMBER, uom: "m" },
    ] },
    { nameEn: "Mouldings", nameAr: "الكرانيش والبراويز", img: MOULDINGS, products: [
      { nameEn: "Skirting Board 2.4m", nameAr: "كرنيش أرضي ٢.٤ م",
        descEn: "Sold per 2.4m length, primed ready for paint.",
        descAr: "يُباع بطول ٢.٤ م، مؤسَّس وجاهز للدهان.",
        price: "55", img: MOULDINGS, featured: true,
        variants: [
          { nameEn: "Primed white", nameAr: "مؤسَّس أبيض", price: "55", stock: 80 },
          { nameEn: "Raw pine", nameAr: "صنوبر خام", price: "48", stock: 40 },
        ] },
      { nameEn: "Cove Moulding", nameAr: "كرنيش سقف",
        descEn: "Ceiling cove, 2.4m length.",
        descAr: "كرنيش سقف بطول ٢.٤ م.",
        price: "48", img: MOULDINGS },
      { nameEn: "Door Architrave", nameAr: "برواز باب",
        descEn: "Single door set, mitred on site.",
        descAr: "طقم باب واحد، يُقص بزاوية في الموقع.",
        price: "40", img: MOULDINGS },
    ] },
    { nameEn: "Fixings", nameAr: "المستلزمات", img: FIXINGS, products: [
      { nameEn: "Wood Screws Box 500pc", nameAr: "صندوق براغي خشب ٥٠٠ حبة",
        descEn: "Countersunk chipboard screws, 500 per box.",
        descAr: "براغي خشب برأس غاطس، ٥٠٠ حبة في الصندوق.",
        price: "180", img: FIXINGS,
        variants: [
          { nameEn: "4 × 30mm", nameAr: "٤ × ٣٠ مم", price: "180", stock: 30 },
          { nameEn: "4 × 50mm", nameAr: "٤ × ٥٠ مم", price: "210", stock: 18 },
        ] },
      { nameEn: "Wood Glue 1L", nameAr: "غراء خشب ١ لتر",
        descEn: "PVA wood adhesive, interior use. Clamp for 30 minutes.",
        descAr: "غراء خشب PVA للاستخدام الداخلي. يُثبَّت بالمشبك ٣٠ دقيقة.",
        price: "90", img: FIXINGS },
      { nameEn: "Hinges Pack", nameAr: "مجموعة مفصلات",
        descEn: "Concealed cabinet hinges with mounting plates, pack of four.",
        descAr: "مفصلات دواليب مخفية مع قواعد التثبيت، عبوة أربع قطع.",
        price: "65", img: HINGES },
      { nameEn: "Sandpaper Pack", nameAr: "ورق صنفرة",
        descEn: "Assorted grits, ten sheets.",
        descAr: "خشونات متنوعة، عشر ورقات.",
        price: "35", img: FIXINGS, trackStock: true, stockQuantity: 0 },
    ] },
    { nameEn: "Handles & Hardware", nameAr: "المقابض والإكسسوارات", img: HANDLES, products: [
      { nameEn: "Cabinet Handle 128mm", nameAr: "مقبض دولاب ١٢٨ مم",
        descEn: "Brushed aluminium bar handle, 128mm hole centres.",
        descAr: "مقبض ألومنيوم مصنفر، المسافة بين الفتحات ١٢٨ مم.",
        price: "45", img: HANDLES, featured: true,
        variants: [
          { nameEn: "Brushed", nameAr: "مصنفر", price: "45", stock: 60 },
          { nameEn: "Matt black", nameAr: "أسود مطفي", price: "52", stock: 35 },
        ] },
      { nameEn: "Drawer Runners 450mm", nameAr: "مجاري أدراج ٤٥٠ مم",
        descEn: "Soft-close ball-bearing runners, pair.",
        descAr: "مجاري بكرات بإغلاق هادئ، زوج.",
        price: "120", img: HINGES },
      { nameEn: "Shelf Supports Pack", nameAr: "حوامل أرفف",
        descEn: "Push-fit shelf pins, pack of twenty.",
        descAr: "مسامير حوامل أرفف بالضغط، عبوة عشرين قطعة.",
        price: "30", img: FIXINGS },
    ] },
  ],
  // Each-priced (non-dimensional) products only — dimensional lines need explicit
  // cut dimensions at checkout and are demonstrated on the storefront, not here.
  orderableNames: ["Skirting Board 2.4m", "Cove Moulding", "Door Architrave", "Wood Glue 1L", "Hinges Pack"],
};

const TENANTS: TenantSeedConfig[] = [RESTAURANT, RETAIL, PHARMACY, TIMBER];

/**
 * Fails fast when a config lists a product that placeOrder cannot actually
 * order, instead of letting the seed run for a minute and then die on the
 * first order with "required modifier missing" — which is what happened the
 * first time required modifier groups were added while the grills were still
 * in the restaurant's orderableNames.
 */
function assertOrderable(cfg: TenantSeedConfig): void {
  const byName = new Map(cfg.catalog.flatMap((c) => c.products).map((p) => [p.nameEn, p]));
  for (const name of cfg.orderableNames) {
    const product = byName.get(name);
    if (!product) {
      throw new Error(`${cfg.slug}: orderableNames lists "${name}", which is not in the catalog`);
    }
    if (product.modifiers?.some((g) => g.required)) {
      throw new Error(
        `${cfg.slug}: orderableNames lists "${name}", which has a required modifier group — ` +
          `placeOrder would reject it. Use a product without one.`,
      );
    }
    if (product.requiresPrescription) {
      throw new Error(`${cfg.slug}: orderableNames lists "${name}", which requires a prescription`);
    }
  }
}

async function seedOneTenant(cfg: TenantSeedConfig, adminId: string) {
  const { db } = await import("../src/db/client");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { users } = await import("../src/server/auth/schema");
  const { registerTenant } = await import("../src/server/onboarding");
  const { approveTenant } = await import("../src/server/platform");
  const { updateTenantProfile } = await import("../src/server/tenancy/service");
  const { setVatRate } = await import("../src/server/tenancy/settings");
  const { createBranch, updateBranchOrdering, listBranches, createDeliveryArea, listDeliveryAreas } = await import("../src/server/branches/service");
  const {
    listCategories, createCategory, createProduct, updateProduct, listProducts,
    upsertModifierGroup, upsertModifierOption,
  } = await import("../src/server/catalog/service");
  const { products: productsTable, categories: categoriesTable, productVariants: productVariantsTable } = await import("../src/server/catalog/schema");
  const { withTenant } = await import("../src/db/with-tenant");
  const { createBanner, listBanners } = await import("../src/server/banners/service");
  const { placeOrder, transitionStatus, listOrders } = await import("../src/server/ordering/service");

  // ── Tenant + owner (idempotent) ───────────────────────────────────────────
  let [tenant] = await db.select().from(tenants).where(eq(tenants.slug, cfg.slug)).limit(1);
  if (!tenant) {
    const reg = await registerTenant({
      restaurantName: cfg.name,
      slug: cfg.slug,
      country: "EG",
      ownerName: cfg.ownerName,
      email: cfg.ownerEmail,
      password: cfg.ownerPassword,
      vertical: cfg.trade,
    });
    await approveTenant(reg.tenantId, adminId);
    [tenant] = await db.select().from(tenants).where(eq(tenants.slug, cfg.slug)).limit(1);
  }
  const tenantId = tenant.id;
  const [owner] = await db.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.email, cfg.ownerEmail))).limit(1);
  if (!owner) throw new Error(`Owner user missing for ${cfg.slug} — registerTenant should have created it`);

  // ── Profile ────────────────────────────────────────────────────────────────
  await updateTenantProfile(tenantId, {
    tagline: cfg.tagline,
    cuisine: cfg.businessType,
    coverImageUrl: cfg.coverImg,
    logoUrl: cfg.logoImg,
  });

  // ── Branch, hours, delivery areas, VAT (idempotent) ─────────────────────────
  let [branch] = await listBranches(tenantId);
  if (!branch) branch = await createBranch(tenantId, { name: "Main Branch" });
  await updateBranchOrdering(tenantId, branch.id, {
    acceptingOrders: true,
    openingHours: Array.from({ length: 7 }, (_, day) => ({ day, open: "09:00", close: "22:00", closed: false })),
  });
  if ((await listDeliveryAreas(tenantId, branch.id)).length === 0) {
    for (const a of cfg.areas) {
      await createDeliveryArea(tenantId, branch.id, { nameEn: a.nameEn, nameAr: a.nameAr, deliveryFee: a.fee, minOrderAmount: a.minOrder, etaMinutes: a.eta });
    }
  }
  await setVatRate(tenantId, 14);

  // ── Catalog (idempotent: wipe + recreate only if missing/incomplete) ───────
  const existingCats = await listCategories(tenantId);
  const existingNames = new Set(existingCats.map((c) => c.nameEn));
  const expectedNames = cfg.catalog.map((c) => c.nameEn);

  // Completeness is judged on CONTENT, not just on names.
  //
  // Names alone are not enough: rewriting every description, adding variants
  // and repointing photography changes no name at all, so a name-keyed check
  // reports "already seeded" and leaves the old catalog in place. That is not
  // hypothetical — it silently skipped three of the four tenants on the run
  // that introduced Arabic descriptions.
  //
  // Comparing the fields the seed actually owns makes re-running the script
  // the way to apply an edit, which is what anyone editing this file expects.
  const existingProducts = new Map((await listProducts(tenantId)).map((p) => [p.nameEn, p]));
  const expectedProducts = cfg.catalog.flatMap((c) => c.products);
  const drifted = expectedProducts.filter((p) => {
    const row = existingProducts.get(p.nameEn);
    if (!row) return true;
    return (
      row.descriptionEn !== p.descEn ||
      row.descriptionAr !== p.descAr ||
      row.imageUrl !== p.img ||
      String(row.basePrice) !== p.price
    );
  });
  const hasFullCatalog = expectedNames.every((n) => existingNames.has(n)) && drifted.length === 0;
  if (drifted.length > 0 && existingProducts.size > 0) {
    console.log(`  catalog changed (${drifted.length} product(s)) — rebuilding`);
  }

  const productByName = new Map<string, { id: string; nameEn: string }>();

  if (!hasFullCatalog) {
    if (existingCats.length > 0) {
      await withTenant(tenantId, async (tx) => {
        await tx.delete(productVariantsTable).where(eq(productVariantsTable.tenantId, tenantId));
        await tx.delete(productsTable).where(eq(productsTable.tenantId, tenantId));
        await tx.delete(categoriesTable).where(eq(categoriesTable.tenantId, tenantId));
      });
    }
    for (const [ci, cat] of cfg.catalog.entries()) {
      const c = await createCategory(tenantId, { nameEn: cat.nameEn, nameAr: cat.nameAr, imageUrl: cat.img, sortOrder: ci });
      for (const [pi, p] of cat.products.entries()) {
        const prod = await createProduct(tenantId, {
          nameEn: p.nameEn,
          nameAr: p.nameAr,
          descriptionEn: p.descEn,
          // Was `p.descEn` — the Arabic column held English for every product in
          // every demo tenant, which an Arabic-first storefront then rendered
          // as the product's own description.
          descriptionAr: p.descAr,
          basePrice: p.price,
          categoryId: c.id,
          imageUrl: p.img,
          isFeatured: !!p.featured,
          sortOrder: pi,
          trackStock: p.trackStock ?? false,
          stockQuantity: p.trackStock ? (p.stockQuantity ?? 0) : null,
        });
        await updateProduct(tenantId, prod.id, { isPublished: true });

        // requiresPrescription and unitOfMeasure are not exposed by
        // createProduct/updateProduct (CreateProductInput omits both) — same
        // escape hatch scripts/seed.ts uses for Roma's ageDays backdating: a
        // direct, tenant-scoped update through withTenant.
        if (p.requiresPrescription || p.uom) {
          await withTenant(tenantId, (tx) =>
            tx.update(productsTable)
              .set({
                ...(p.requiresPrescription ? { requiresPrescription: true } : {}),
                ...(p.uom ? { unitOfMeasure: p.uom } : {}),
              })
              .where(eq(productsTable.id, prod.id)),
          );
        }

        if (p.variants && p.variants.length > 0) {
          await withTenant(tenantId, async (tx) => {
            for (const [vi, v] of p.variants!.entries()) {
              await tx.insert(productVariantsTable).values({
                tenantId, productId: prod.id, nameEn: v.nameEn, nameAr: v.nameAr, price: v.price, stockQuantity: v.stock, sortOrder: vi,
              });
            }
          });
        }

        // Modifier groups go through the service, not a raw insert, because
        // upsertModifierGroup is what validates the selection rules
        // (min <= max, required implies min >= 1) and the vertical capability.
        // Nothing else in the demo data exercised this path, so the POS
        // take-order screen never opened its modifier sheet.
        for (const [gi, g] of (p.modifiers ?? []).entries()) {
          const group = await upsertModifierGroup(tenantId, prod.id, {
            nameEn: g.nameEn,
            nameAr: g.nameAr,
            required: g.required,
            minSelections: g.minSelections,
            maxSelections: g.maxSelections,
            sortOrder: gi,
          });
          for (const [oi, o] of g.options.entries()) {
            await upsertModifierOption(tenantId, group.id, {
              nameEn: o.nameEn,
              nameAr: o.nameAr,
              priceDelta: o.priceDelta ?? "0",
              isDefault: o.isDefault ?? false,
              sortOrder: oi,
            });
          }
        }

        productByName.set(p.nameEn, prod);
      }
    }
  } else {
    for (const p of await listProducts(tenantId)) productByName.set(p.nameEn, p);
  }

  // ── Hero banner (idempotent) ────────────────────────────────────────────────
  if ((await listBanners(tenantId)).length === 0) {
    await createBanner(tenantId, { imageUrl: cfg.coverImg, titleEn: cfg.tagline, titleAr: cfg.taglineAr, sortOrder: 0 });
  }

  // ── Orders across every status the dashboard snapshot cares about ──────────
  // (pending, preparing, ready, completed) — seeded once, never re-created.
  const existingOrders = await listOrders(tenantId, { limit: 1 });
  if (existingOrders.length === 0) {
    const now = new Date();
    now.setHours(14, 0, 0, 0); // mid-afternoon, always inside 09:00–22:00 opening hours

    const customers: Array<{ name: string; phone: string }> = [
      { name: "Ahmed Samir", phone: "01000000101" },
      { name: "Sara Hassan", phone: "01000000102" },
      { name: "Mahmoud Adel", phone: "01000000103" },
      { name: "Nour Ali", phone: "01000000104" },
      { name: "Karim Fouad", phone: "01000000105" },
      { name: "Dina Youssef", phone: "01000000106" },
      { name: "Omar Khaled", phone: "01000000107" },
      { name: "Rania Tarek", phone: "01000000108" },
    ];
    // Two orders land on each terminal-ish status the Home snapshot counts;
    // the first orderable product gets extra volume so popularity has a clear
    // winner rather than an eight-way tie.
    const plan: Array<{ status: "pending" | "preparing" | "ready" | "completed"; productIndex: number; qty: number }> = [
      { status: "pending", productIndex: 0, qty: 2 },
      { status: "pending", productIndex: 1, qty: 1 },
      { status: "preparing", productIndex: 0, qty: 2 },
      { status: "preparing", productIndex: 2, qty: 1 },
      { status: "ready", productIndex: 0, qty: 3 },
      { status: "ready", productIndex: 3, qty: 1 },
      { status: "completed", productIndex: 1, qty: 2 },
      { status: "completed", productIndex: 4 % cfg.orderableNames.length, qty: 1 },
    ];

    for (const [i, step] of plan.entries()) {
      const name = cfg.orderableNames[step.productIndex % cfg.orderableNames.length];
      const product = productByName.get(name);
      if (!product) continue;
      const customer = customers[i % customers.length];

      const placed = await placeOrder(tenantId, {
        branchId: branch.id,
        fulfillmentType: "pickup",
        customerName: customer.name,
        customerPhone: customer.phone,
        lines: [{ productId: product.id, quantity: step.qty, selectedOptionIds: [] }],
        now,
      });

      if (step.status === "pending") continue;
      await transitionStatus(tenantId, placed.orderId, "confirmed", owner.id);
      await transitionStatus(tenantId, placed.orderId, "preparing", owner.id);
      if (step.status === "preparing") continue;
      await transitionStatus(tenantId, placed.orderId, "ready", owner.id);
      if (step.status === "ready") continue;
      await transitionStatus(tenantId, placed.orderId, "completed", owner.id);
    }
  }

  console.log(`  ${cfg.slug.padEnd(16)} owner: ${cfg.ownerEmail} / ${cfg.ownerPassword}`);
}

/**
 * --reset drops each demo tenant before re-seeding it, rather than reconciling
 * it in place.
 *
 * The demo is publicly writable: anyone who opens the dashboard door can edit
 * products, place orders, close shifts. Reconciliation cannot undo all of
 * that — the catalogue rebuild only fires when the SEED's own fields drift,
 * and it would leave a visitor's orders, shifts and stock movements behind
 * forever. Deleting the tenant row does undo it: every table that references
 * tenants does so with onDelete: cascade.
 *
 * Only ever applied to slugs this file owns, all of which are `demo-<trade>`.
 */
async function resetTenants(): Promise<void> {
  const { db } = await import("../src/db/client");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { eq: equals } = await import("drizzle-orm");

  for (const cfg of TENANTS) {
    if (!cfg.slug.startsWith("demo-")) {
      throw new Error(`refusing to reset "${cfg.slug}" — only demo- tenants may be dropped`);
    }
    const deleted = await db.delete(tenants).where(equals(tenants.slug, cfg.slug)).returning({ id: tenants.id });
    if (deleted.length > 0) console.log(`  reset: dropped ${cfg.slug}`);
  }
}

async function main() {
  const { db, pool } = await import("../src/db/client");
  const { users } = await import("../src/server/auth/schema");
  const { hashPassword } = await import("../src/server/auth/password");
  const { seedDefaultPlans } = await import("../src/server/subscription");
  const { ensurePlatformSuperAdmin } = await import("../src/server/auth/platform-admin");

  await seedDefaultPlans();

  if (process.argv.includes("--reset")) {
    console.log("Resetting demo tenants (--reset)...\n");
    await resetTenants();
  }

  // Platform super-admin, needed to approve each new tenant (mirrors scripts/seed.ts).
  const adminEmail = "admin@serveos.com";
  let [admin] = await db.select().from(users).where(and(eq(users.email, adminEmail), isNull(users.tenantId))).limit(1);
  if (!admin) {
    [admin] = await db
      .insert(users)
      .values({ tenantId: null, name: "Platform Admin", email: adminEmail, passwordHash: await hashPassword("admin1234") })
      .returning();
  }
  await ensurePlatformSuperAdmin(adminEmail);

  // Validate every config before writing anything — a bad orderableNames
  // entry should not be discovered three tenants into the run.
  for (const cfg of TENANTS) assertOrderable(cfg);

  console.log("Seeding demo tenants...\n");
  for (const cfg of TENANTS) {
    await seedOneTenant(cfg, admin.id);
  }

  console.log(`
Demo tenants ready — storefronts (ROOT_DOMAIN=${process.env.ROOT_DOMAIN ?? "serveos.localhost"}):
`);
  for (const cfg of TENANTS) {
    console.log(`  http://${cfg.slug}.${process.env.ROOT_DOMAIN ?? "serveos.localhost"}:3000`);
  }
  console.log("");

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
