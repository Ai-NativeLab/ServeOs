import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });
import { and, eq, isNull } from "drizzle-orm";

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

const IMG = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;

type Trade = "restaurant" | "retail" | "pharmacy" | "timber";

type SeedVariant = { nameEn: string; nameAr: string; price: string; stock: number | null };
type SeedProduct = {
  nameEn: string;
  nameAr: string;
  descEn?: string;
  price: string;
  img: string;
  featured?: boolean;
  trackStock?: boolean;
  stockQuantity?: number | null;
  requiresPrescription?: boolean;
  /** P4 dimensional pricing (timber): basePrice above is reinterpreted as price-per-unit-of-measure. */
  uom?: "m" | "m2";
  variants?: SeedVariant[];
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
  /** Simple, each-priced, non-Rx, non-variant products safe to run through placeOrder. */
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
  coverImg: IMG("1600335895229-6e75511892c8"),
  logoImg: IMG("1607330289024-1535c6b4e1c1"),
  areas: [
    { nameEn: "Dokki", nameAr: "الدقي", fee: "20", minOrder: "80", eta: 30 },
    { nameEn: "Mohandessin", nameAr: "المهندسين", fee: "30", minOrder: "100", eta: 40 },
  ],
  catalog: [
    { nameEn: "Grills", nameAr: "مشويات", img: IMG("1544025162-d76694265947"), products: [
      { nameEn: "Grilled Chicken Half", nameAr: "نصف فرخة مشوية", descEn: "Charcoal-grilled, lemon-garlic marinade.", price: "120", img: IMG("1544025162-d76694265947"), featured: true },
      { nameEn: "Kofta Skewer", nameAr: "كفتة مشوية", descEn: "Hand-minced beef, parsley, onion, grilled over charcoal.", price: "110", img: IMG("1544025162-d76694265947"), featured: true },
      { nameEn: "Lamb Chops", nameAr: "ريش ضاني", descEn: "Marinated lamb chops, grilled to order.", price: "220", img: IMG("1544025162-d76694265947") },
      { nameEn: "Mixed Grill Platter", nameAr: "مشويات مشكلة", descEn: "Kofta, kebab, chicken — a table for two.", price: "260", img: IMG("1544025162-d76694265947") },
    ] },
    { nameEn: "Mezze & Salads", nameAr: "مقبلات وسلطات", img: IMG("1512621776951-a57141f2eefd"), products: [
      { nameEn: "Hummus", nameAr: "حمص", descEn: "Chickpea, tahini, lemon, olive oil.", price: "45", img: IMG("1512621776951-a57141f2eefd"), featured: true },
      { nameEn: "Baba Ghanoush", nameAr: "بابا غنوج", descEn: "Smoked eggplant, tahini, garlic.", price: "45", img: IMG("1512621776951-a57141f2eefd") },
      { nameEn: "Fattoush Salad", nameAr: "سلطة فتوش", descEn: "Crisp vegetables, toasted bread, sumac dressing.", price: "55", img: IMG("1512621776951-a57141f2eefd") },
      { nameEn: "Baladi Salad", nameAr: "سلطة بلدي", descEn: "Tomato, cucumber, onion, parsley.", price: "35", img: IMG("1512621776951-a57141f2eefd") },
    ] },
    { nameEn: "Rice & Sides", nameAr: "أرز وأطباق جانبية", img: IMG("1587854692152-cbe660dbde88"), products: [
      { nameEn: "Rice with Vermicelli", nameAr: "أرز بالشعيرية", price: "30", img: IMG("1587854692152-cbe660dbde88") },
      { nameEn: "Freekeh", nameAr: "فريكة", price: "40", img: IMG("1587854692152-cbe660dbde88") },
      { nameEn: "Grilled Vegetables", nameAr: "خضار مشكلة مشوية", price: "45", img: IMG("1587854692152-cbe660dbde88") },
    ] },
    { nameEn: "Drinks", nameAr: "مشروبات", img: IMG("1621905251189-08b45d6a269e"), products: [
      { nameEn: "Hibiscus Tea", nameAr: "كركديه", price: "25", img: IMG("1621905251189-08b45d6a269e") },
      { nameEn: "Fresh Lemon & Mint", nameAr: "ليمون بالنعناع", price: "30", img: IMG("1621905251189-08b45d6a269e") },
      { nameEn: "Soft Drink", nameAr: "مياه غازية", price: "20", img: IMG("1621905251189-08b45d6a269e") },
    ] },
    { nameEn: "Desserts", nameAr: "حلويات", img: IMG("1551024601-bec78aea704b"), products: [
      { nameEn: "Om Ali", nameAr: "أم علي", descEn: "Baked bread pudding, cream, nuts.", price: "55", img: IMG("1551024601-bec78aea704b"), featured: true },
      { nameEn: "Kunafa", nameAr: "كنافة", price: "60", img: IMG("1551024601-bec78aea704b") },
    ] },
  ],
  orderableNames: ["Grilled Chicken Half", "Kofta Skewer", "Hummus", "Rice with Vermicelli", "Om Ali"],
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
  coverImg: IMG("1585421514738-01798e348b17"),
  logoImg: IMG("1541529086526-db283c563270"),
  areas: [
    { nameEn: "Heliopolis", nameAr: "مصر الجديدة", fee: "15", minOrder: "50", eta: 25 },
  ],
  catalog: [
    { nameEn: "Snacks", nameAr: "سناكس", img: IMG("1584949091598-c31daaaa4aa9"), products: [
      { nameEn: "Potato Chips Family Pack", nameAr: "شيبسي عبوة كبيرة", price: "45", img: IMG("1584949091598-c31daaaa4aa9"), featured: true },
      { nameEn: "Chocolate Bar", nameAr: "شيكولاتة", price: "25", img: IMG("1584949091598-c31daaaa4aa9") },
      { nameEn: "Biscuits Pack", nameAr: "بسكويت", price: "20", img: IMG("1584949091598-c31daaaa4aa9") },
      { nameEn: "Salted Peanuts", nameAr: "فول سوداني مملح", price: "30", img: IMG("1584949091598-c31daaaa4aa9"), trackStock: true, stockQuantity: 0 },
    ] },
    { nameEn: "Beverages", nameAr: "مشروبات", img: IMG("1607619056574-7b8d3ee536b2"), products: [
      { nameEn: "Bottled Water 6-pack", nameAr: "مياه معدنية ٦ عبوات", price: "30", img: IMG("1607619056574-7b8d3ee536b2"), featured: true },
      { nameEn: "Soft Drink 1.5L", nameAr: "مشروب غازي ١.٥ لتر", price: "25", img: IMG("1607619056574-7b8d3ee536b2") },
      { nameEn: "Juice Carton", nameAr: "عصير", price: "22", img: IMG("1607619056574-7b8d3ee536b2") },
    ] },
    { nameEn: "Dairy & Eggs", nameAr: "ألبان وبيض", img: IMG("1560343090-f0409e92791a"), products: [
      { nameEn: "Milk 1L", nameAr: "لبن ١ لتر", price: "35", img: IMG("1560343090-f0409e92791a"),
        variants: [
          { nameEn: "Full Fat", nameAr: "كامل الدسم", price: "35", stock: 40 },
          { nameEn: "Low Fat", nameAr: "قليل الدسم", price: "35", stock: 25 },
        ] },
      { nameEn: "Eggs Tray 30pc", nameAr: "كرتونة بيض ٣٠ بيضة", price: "110", img: IMG("1560343090-f0409e92791a"), featured: true },
      { nameEn: "White Cheese 500g", nameAr: "جبنة بيضاء ٥٠٠ جم", price: "90", img: IMG("1560343090-f0409e92791a") },
    ] },
    { nameEn: "Household", nameAr: "منزلية", img: IMG("1590212151175-e58edd96185b"), products: [
      { nameEn: "Dish Soap", nameAr: "سائل غسيل الأطباق", price: "40", img: IMG("1590212151175-e58edd96185b") },
      { nameEn: "Tissue Box", nameAr: "مناديل ورقية", price: "25", img: IMG("1590212151175-e58edd96185b") },
      { nameEn: "Laundry Detergent", nameAr: "مسحوق غسيل", price: "150", img: IMG("1590212151175-e58edd96185b"),
        variants: [
          { nameEn: "1kg", nameAr: "١ كجم", price: "60", stock: 30 },
          { nameEn: "3kg", nameAr: "٣ كجم", price: "150", stock: 10 },
        ] },
      { nameEn: "Toothpaste", nameAr: "معجون أسنان", price: "35", img: IMG("1590212151175-e58edd96185b") },
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
  coverImg: IMG("1550989460-0adf9ea622e2"),
  logoImg: IMG("1584362917165-526a968579e8"),
  areas: [
    { nameEn: "Nasr City", nameAr: "مدينة نصر", fee: "15", minOrder: "60", eta: 25 },
  ],
  catalog: [
    { nameEn: "Medicines", nameAr: "أدوية", img: IMG("1587293852726-70cdb56c2866"), products: [
      { nameEn: "Panadol Extra 24 Tabs", nameAr: "بانادول إكسترا ٢٤ قرص", price: "25", img: IMG("1587293852726-70cdb56c2866"), featured: true },
      { nameEn: "Augmentin 1g", nameAr: "أوجمنتين ١ جرام", price: "85", img: IMG("1587293852726-70cdb56c2866"), requiresPrescription: true },
      { nameEn: "Vitamin C 1000mg", nameAr: "فيتامين سي ١٠٠٠ مجم", price: "60", img: IMG("1587293852726-70cdb56c2866") },
      { nameEn: "Antacid Syrup", nameAr: "شراب مضاد للحموضة", price: "35", img: IMG("1587293852726-70cdb56c2866") },
      { nameEn: "Cough Syrup", nameAr: "شراب للسعال", price: "40", img: IMG("1587293852726-70cdb56c2866") },
    ] },
    { nameEn: "Personal Care", nameAr: "العناية الشخصية", img: IMG("1583258292688-d0213dc5a3a8"), products: [
      { nameEn: "Hand Sanitizer 500ml", nameAr: "معقم يدين ٥٠٠ مل", price: "45", img: IMG("1583258292688-d0213dc5a3a8"), featured: true },
      { nameEn: "Sunscreen SPF50", nameAr: "واقي شمس ٥٠", price: "180", img: IMG("1583258292688-d0213dc5a3a8") },
      { nameEn: "Anti-Dandruff Shampoo", nameAr: "شامبو ضد القشرة", price: "95", img: IMG("1583258292688-d0213dc5a3a8") },
      { nameEn: "Sensitive Toothpaste", nameAr: "معجون أسنان للأسنان الحساسة", price: "55", img: IMG("1583258292688-d0213dc5a3a8") },
    ] },
    { nameEn: "Baby Care", nameAr: "عناية الطفل", img: IMG("1512909006721-3d6018887383"), products: [
      { nameEn: "Diapers Size 4", nameAr: "حفاضات مقاس ٤", price: "210", img: IMG("1512909006721-3d6018887383"), featured: true },
      { nameEn: "Baby Formula 400g", nameAr: "حليب أطفال ٤٠٠ جم", price: "260", img: IMG("1512909006721-3d6018887383") },
      { nameEn: "Baby Wipes", nameAr: "مناديل مبللة للأطفال", price: "45", img: IMG("1512909006721-3d6018887383") },
      { nameEn: "Baby Lotion", nameAr: "لوشن للأطفال", price: "70", img: IMG("1512909006721-3d6018887383") },
    ] },
    { nameEn: "Vitamins & Supplements", nameAr: "فيتامينات ومكملات", img: IMG("1567620905732-2d1ec7ab7445"), products: [
      { nameEn: "Multivitamin Adult", nameAr: "فيتامينات متعددة للبالغين", price: "150", img: IMG("1567620905732-2d1ec7ab7445") },
      { nameEn: "Omega-3 Capsules", nameAr: "أوميجا ٣", price: "220", img: IMG("1567620905732-2d1ec7ab7445"), trackStock: true, stockQuantity: 0 },
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
  coverImg: IMG("1583947581924-860bda6a26df"),
  logoImg: IMG("1584017911766-d451b3d0e843"),
  areas: [
    { nameEn: "Sheikh Zayed", nameAr: "الشيخ زايد", fee: "50", minOrder: "300", eta: 90 },
  ],
  catalog: [
    { nameEn: "Sheet Goods", nameAr: "الألواح", img: IMG("1600585154340-be6161a56a0c"), products: [
      { nameEn: "MDF Board 18mm", nameAr: "لوح MDF ١٨ مم", descEn: "Priced per m² — enter length and width at checkout.", price: "220", img: IMG("1600585154340-be6161a56a0c"), featured: true, uom: "m2" },
      { nameEn: "Plywood 12mm", nameAr: "أبلاكاش ١٢ مم", descEn: "Priced per m² — enter length and width at checkout.", price: "260", img: IMG("1600585154340-be6161a56a0c"), uom: "m2" },
      { nameEn: "Melamine Board White 16mm", nameAr: "لوح ميلامين أبيض ١٦ مم", descEn: "Priced per m² — enter length and width at checkout.", price: "240", img: IMG("1600585154340-be6161a56a0c"), uom: "m2" },
      { nameEn: "HDF Board 6mm", nameAr: "لوح HDF ٦ مم", descEn: "Priced per m² — enter length and width at checkout.", price: "140", img: IMG("1600585154340-be6161a56a0c"), uom: "m2" },
    ] },
    { nameEn: "Planed Timber", nameAr: "الأخشاب المنجورة", img: IMG("1583947215259-38e31be8751f"), products: [
      { nameEn: "Pine Timber 2x4\"", nameAr: "خشب صنوبر ٢×٤ بوصة", descEn: "Priced per linear metre — enter length at checkout.", price: "45", img: IMG("1583947215259-38e31be8751f"), featured: true, uom: "m" },
      { nameEn: "Meranti Timber 1x6\"", nameAr: "خشب ميرانتي ١×٦ بوصة", descEn: "Priced per linear metre — enter length at checkout.", price: "65", img: IMG("1583947215259-38e31be8751f"), uom: "m" },
      { nameEn: "Beech Timber 1x2\"", nameAr: "خشب زان ١×٢ بوصة", descEn: "Priced per linear metre — enter length at checkout.", price: "38", img: IMG("1583947215259-38e31be8751f"), uom: "m" },
    ] },
    { nameEn: "Mouldings", nameAr: "الكرانيش والبراويز", img: IMG("1584308666744-24d5c474f2ae"), products: [
      { nameEn: "Skirting Board 2.4m", nameAr: "كرنيش أرضي ٢.٤ م", price: "55", img: IMG("1584308666744-24d5c474f2ae"), featured: true },
      { nameEn: "Cove Moulding", nameAr: "كرنيش سقف", price: "48", img: IMG("1584308666744-24d5c474f2ae") },
      { nameEn: "Door Architrave", nameAr: "برواز باب", price: "40", img: IMG("1584308666744-24d5c474f2ae") },
    ] },
    { nameEn: "Fixings", nameAr: "المستلزمات", img: IMG("1600891964092-4316c288032e"), products: [
      { nameEn: "Wood Screws Box 500pc", nameAr: "صندوق براغي خشب ٥٠٠ حبة", price: "180", img: IMG("1600891964092-4316c288032e") },
      { nameEn: "Wood Glue 1L", nameAr: "غراء خشب ١ لتر", price: "90", img: IMG("1600891964092-4316c288032e") },
      { nameEn: "Hinges Pack", nameAr: "مجموعة مفصلات", price: "65", img: IMG("1600891964092-4316c288032e") },
      { nameEn: "Sandpaper Pack", nameAr: "ورق صنفرة", price: "35", img: IMG("1600891964092-4316c288032e"), trackStock: true, stockQuantity: 0 },
    ] },
  ],
  // Each-priced (non-dimensional) products only — dimensional lines need explicit
  // cut dimensions at checkout and are demonstrated on the storefront, not here.
  orderableNames: ["Skirting Board 2.4m", "Cove Moulding", "Door Architrave", "Wood Glue 1L", "Hinges Pack"],
};

const TENANTS: TenantSeedConfig[] = [RESTAURANT, RETAIL, PHARMACY, TIMBER];

async function seedOneTenant(cfg: TenantSeedConfig, adminId: string) {
  const { db } = await import("../src/db/client");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { users } = await import("../src/server/auth/schema");
  const { registerTenant } = await import("../src/server/onboarding");
  const { approveTenant } = await import("../src/server/platform");
  const { updateTenantProfile } = await import("../src/server/tenancy/service");
  const { setVatRate } = await import("../src/server/tenancy/settings");
  const { createBranch, updateBranchOrdering, listBranches, createDeliveryArea, listDeliveryAreas } = await import("../src/server/branches/service");
  const { listCategories, createCategory, createProduct, updateProduct, listProducts } = await import("../src/server/catalog/service");
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
  const hasFullCatalog = expectedNames.every((n) => existingNames.has(n));

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
          descriptionEn: p.descEn ?? null,
          descriptionAr: p.descEn ?? null,
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

async function main() {
  const { db, pool } = await import("../src/db/client");
  const { users } = await import("../src/server/auth/schema");
  const { hashPassword } = await import("../src/server/auth/password");
  const { seedDefaultPlans } = await import("../src/server/subscription");
  const { ensurePlatformSuperAdmin } = await import("../src/server/auth/platform-admin");

  await seedDefaultPlans();

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
