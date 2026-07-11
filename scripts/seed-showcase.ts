import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });
import { eq } from "drizzle-orm";

/**
 * Seeds ONLY storefront "showcase" content for an existing tenant (default: roma):
 * brand tagline/cuisine/imagery, a rich imaged catalog, Size modifiers, banners,
 * sensible ordering config, and popular-signal orders. It is tenant-scoped and
 * creates NO users and touches NO other tenant — safe to run against production
 * to turn a demo tenant into a showcase.
 *
 *   ENV_FILE=.env.prod npx tsx scripts/seed-showcase.ts roma
 *
 * (Content mirrors the Roma block of scripts/seed.ts; a future cleanup could DRY
 *  the two by extracting a shared side-effect-free module.)
 */

const IMG = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;

const ROMA_MENU: Array<{
  cat: { nameEn: string; nameAr: string; img: string };
  products: Array<{ nameEn: string; nameAr: string; descEn: string; price: string; img: string; featured?: boolean; ageDays?: number }>;
}> = [
  { cat: { nameEn: "Pizza", nameAr: "بيتزا", img: "1513104890138-7c749659a591" }, products: [
    { nameEn: "Margherita", nameAr: "مارجريتا", descEn: "San Marzano tomato, fior di latte, fresh basil, cold-pressed olive oil.", price: "145", img: "1513104890138-7c749659a591", featured: true },
    { nameEn: "Diavola", nameAr: "ديافولا", descEn: "Spicy salami, mozzarella, chili honey drizzle.", price: "175", img: "1628840042765-356cda07504e", ageDays: 3 },
    { nameEn: "Quattro Formaggi", nameAr: "أربعة أجبان", descEn: "Mozzarella, gorgonzola, parmesan, taleggio.", price: "190", img: "1601924582970-9238bcb495d9" },
    { nameEn: "Marinara", nameAr: "مارينارا", descEn: "Tomato, garlic, oregano, extra virgin olive oil.", price: "120", img: "1571407970349-bc81e7e96d47" },
    { nameEn: "Prosciutto e Rucola", nameAr: "بروشوتو وجرجير", descEn: "Parma ham, rocket, shaved parmesan, cherry tomatoes.", price: "210", img: "1595854341625-f33ee10dbf94" },
  ]},
  { cat: { nameEn: "Pasta", nameAr: "باستا", img: "1621996346565-e3dbc646d9a9" }, products: [
    { nameEn: "Spaghetti Carbonara", nameAr: "سباجيتي كاربونارا", descEn: "Guanciale, egg yolk, pecorino romano, black pepper.", price: "165", img: "1612874742237-6526221588e3", featured: true },
    { nameEn: "Penne Arrabbiata", nameAr: "بيني أرابياتا", descEn: "Tomato, garlic, chili, parsley.", price: "135", img: "1563379926898-05f4575a45d8" },
    { nameEn: "Fettuccine Alfredo", nameAr: "فيتوتشيني ألفريدو", descEn: "Butter, cream, parmesan, nutmeg.", price: "155", img: "1645112411341-6c4fd023714a", ageDays: 5 },
    { nameEn: "Lasagna Bolognese", nameAr: "لازانيا بولونيز", descEn: "Slow-cooked beef ragù, béchamel, parmesan.", price: "185", img: "1619895092538-128341789043" },
    { nameEn: "Pesto Genovese", nameAr: "بيستو جينوفيز", descEn: "Basil pesto, pine nuts, green beans, potato.", price: "150", img: "1473093295043-cdd812d0e601" },
  ]},
  { cat: { nameEn: "Salads", nameAr: "سلطات", img: "1512621776951-a57141f2eefd" }, products: [
    { nameEn: "Caprese", nameAr: "كابريزي", descEn: "Buffalo mozzarella, heirloom tomato, basil, balsamic.", price: "110", img: "1608897013039-887f21d8c804", featured: true },
    { nameEn: "Caesar", nameAr: "سيزر", descEn: "Romaine, parmesan, croutons, anchovy dressing.", price: "95", img: "1550304943-4f24f54ddde9" },
    { nameEn: "Rucola & Parmesan", nameAr: "جرجير وبارميزان", descEn: "Rocket, shaved parmesan, lemon, olive oil.", price: "90", img: "1540420773420-3366772f4999" },
  ]},
  { cat: { nameEn: "Starters", nameAr: "مقبلات", img: "1541529086526-db283c563270" }, products: [
    { nameEn: "Bruschetta", nameAr: "بروشيتا", descEn: "Grilled sourdough, tomato, garlic, basil.", price: "75", img: "1572695157366-5e585ab2b69f", featured: true },
    { nameEn: "Arancini", nameAr: "أرانشيني", descEn: "Fried risotto balls, mozzarella, marinara.", price: "95", img: "1580217593608-61931cefc821", ageDays: 2 },
    { nameEn: "Garlic Bread", nameAr: "خبز بالثوم", descEn: "Wood-fired, garlic butter, parsley.", price: "55", img: "1573140247632-f8fd74997d5c" },
    { nameEn: "Antipasto Misto", nameAr: "أنتيباستو", descEn: "Cured meats, cheeses, olives, grilled vegetables.", price: "160", img: "1544025162-d76694265947" },
  ]},
  { cat: { nameEn: "Dolci", nameAr: "حلويات", img: "1551024601-bec78aea704b" }, products: [
    { nameEn: "Tiramisù", nameAr: "تيراميسو", descEn: "Espresso-soaked savoiardi, mascarpone, cocoa.", price: "85", img: "1571877227200-a0d98ea607e9", featured: true },
    { nameEn: "Panna Cotta", nameAr: "بانا كوتا", descEn: "Vanilla cream, berry coulis.", price: "75", img: "1488477181946-6428a0291777" },
    { nameEn: "Cannoli", nameAr: "كانولي", descEn: "Crisp shells, sweet ricotta, pistachio.", price: "80", img: "1607920591413-4ec007e70023", ageDays: 6 },
  ]},
  { cat: { nameEn: "Drinks", nameAr: "مشروبات", img: "1437418747212-8d9709afab22" }, products: [
    { nameEn: "San Pellegrino", nameAr: "سان بيليجرينو", descEn: "Sparkling mineral water, 500ml.", price: "45", img: "1523371054106-bbf80586c33c" },
    { nameEn: "Fresh Lemonade", nameAr: "ليموناضة", descEn: "Lemon, mint, lightly sweetened.", price: "50", img: "1621263764928-df1444c5e859" },
    { nameEn: "Italian Soda", nameAr: "صودا إيطالية", descEn: "Sparkling water, fruit syrup.", price: "55", img: "1437418747212-8d9709afab22" },
    { nameEn: "Espresso", nameAr: "إسبريسو", descEn: "Double shot, Italian roast.", price: "40", img: "1510591509098-f4fdc6d0ff04" },
  ]},
];

async function main() {
  const slug = process.argv[2] ?? "roma";
  const { db, pool } = await import("../src/db/client");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { updateTenantProfile } = await import("../src/server/tenancy/service");
  const { setVatRate } = await import("../src/server/tenancy/settings");
  const { listBranches, createBranch, updateBranchOrdering, listDeliveryAreas, createDeliveryArea } = await import("../src/server/branches/service");
  const { listCategories, createCategory, createProduct, updateProduct, getProduct, listProducts, upsertModifierGroup, upsertModifierOption } = await import("../src/server/catalog/service");
  const { listBanners, createBanner } = await import("../src/server/banners/service");
  const { placeOrder } = await import("../src/server/ordering/service");
  const { products: productsTable, categories: categoriesTable } = await import("../src/server/catalog/schema");
  const { orders: ordersTable } = await import("../src/server/ordering/schema");
  const { withTenant } = await import("../src/db/with-tenant");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!tenant) {
    console.error(`No tenant with slug '${slug}'. This script only populates an existing tenant.`);
    process.exit(1);
  }
  const tid = tenant.id;
  console.log(`Seeding showcase content for '${slug}' (${tid}) …`);

  // ── Brand profile ───────────────────────────────────────────────────────────
  await updateTenantProfile(tid, {
    tagline: "Wood-fired Italian, made fresh",
    cuisine: "Italian",
    coverImageUrl: IMG("1517248135467-4c7edcad34c4"),
    logoUrl: IMG("1552566626-52f8b828add9"),
  });

  // ── Branch + ordering config ────────────────────────────────────────────────
  let branches = await listBranches(tid);
  if (branches.length === 0) { await createBranch(tid, { name: "Main Branch" }); branches = await listBranches(tid); }
  const branch = branches[0];
  await updateBranchOrdering(tid, branch.id, {
    acceptingOrders: true,
    openingHours: Array.from({ length: 7 }, (_, day) => ({ day, open: "10:00", close: "23:00", closed: false })),
  });
  if ((await listDeliveryAreas(tid, branch.id)).length === 0) {
    await createDeliveryArea(tid, branch.id, { nameEn: "Maadi", nameAr: "المعادي", deliveryFee: "25", minOrderAmount: "100", etaMinutes: 35 });
    await createDeliveryArea(tid, branch.id, { nameEn: "Nasr City", nameAr: "مدينة نصر", deliveryFee: "40", minOrderAmount: "150", etaMinutes: 50 });
  }
  await setVatRate(tid, 14);

  // ── Catalog: clean the tenant's existing catalog, then seed the rich menu ─────
  const existing = await listCategories(tid);
  if (existing.length > 0) {
    await withTenant(tid, async (tx) => {
      await tx.delete(productsTable).where(eq(productsTable.tenantId, tid));
      await tx.delete(categoriesTable).where(eq(categoriesTable.tenantId, tid));
    });
  }
  for (const entry of ROMA_MENU) {
    const cat = await createCategory(tid, { nameEn: entry.cat.nameEn, nameAr: entry.cat.nameAr, imageUrl: IMG(entry.cat.img) });
    for (const pr of entry.products) {
      const p = await createProduct(tid, {
        nameEn: pr.nameEn, nameAr: pr.nameAr, descriptionEn: pr.descEn, descriptionAr: pr.descEn,
        basePrice: pr.price, categoryId: cat.id, imageUrl: IMG(pr.img), isFeatured: !!pr.featured,
      });
      await updateProduct(tid, p.id, { isPublished: true });
      if (pr.ageDays) {
        await withTenant(tid, (tx) =>
          tx.update(productsTable).set({ createdAt: new Date(Date.now() - pr.ageDays! * 24 * 60 * 60 * 1000) }).where(eq(productsTable.id, p.id)),
        );
      }
      if (["Pizza", "Pasta", "Drinks"].includes(entry.cat.nameEn)) {
        const g = await upsertModifierGroup(tid, p.id, { nameEn: "Size", nameAr: "الحجم", required: true, minSelections: 1, maxSelections: 1 });
        await upsertModifierOption(tid, g.id, { nameEn: "Regular", nameAr: "عادي", priceDelta: "0", isDefault: true });
        await upsertModifierOption(tid, g.id, { nameEn: "Large", nameAr: "كبير", priceDelta: "35" });
      }
    }
  }

  // ── Banners ─────────────────────────────────────────────────────────────────
  if ((await listBanners(tid)).length === 0) {
    await createBanner(tid, { imageUrl: IMG("1513104890138-7c749659a591"), titleEn: "Wood-fired pizza, made fresh daily", titleAr: "بيتزا بالفرن الخشبي، طازجة يوميًا", sortOrder: 0 });
    await createBanner(tid, { imageUrl: IMG("1551024601-bec78aea704b"), titleEn: "New: our Dolci selection", titleAr: "جديد: تشكيلة الحلويات", sortOrder: 1 });
    await createBanner(tid, { imageUrl: IMG("1544025162-d76694265947"), titleEn: "Antipasto Misto — a table full of Italy", titleAr: "أنتيباستو ميستو — مائدة إيطالية كاملة", sortOrder: 2 });
  }

  // ── Popular-signal orders (so getPopularProductIds has clear winners) ─────────
  const POPULAR_SIGNAL_PHONE = "01099998888";
  const marker = await withTenant(tid, (tx) =>
    tx.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.customerPhone, POPULAR_SIGNAL_PHONE)).limit(1),
  );
  if (marker.length === 0) {
    const now = new Date(); now.setHours(14, 0, 0, 0);
    const allProducts = await listProducts(tid);
    const byName = (nameEn: string) => allProducts.find((p) => p.nameEn === nameEn);
    const regularOptionId = async (productId: string): Promise<string | undefined> => {
      const full = await getProduct(tid, productId);
      return full.modifierGroups.find((g) => g.nameEn === "Size")?.options.find((o) => o.nameEn === "Regular")?.id;
    };
    const winners = [
      { name: "Margherita", times: 5, qty: 2 },
      { name: "Diavola", times: 4, qty: 2 },
      { name: "Spaghetti Carbonara", times: 4, qty: 2 },
      { name: "Caprese", times: 2, qty: 1 },
    ];
    for (const w of winners) {
      const product = byName(w.name);
      if (!product) continue;
      const optionId = await regularOptionId(product.id);
      for (let n = 0; n < w.times; n++) {
        await placeOrder(tid, {
          branchId: branch.id, fulfillmentType: "pickup",
          customerName: "Layla Fahmy", customerPhone: POPULAR_SIGNAL_PHONE,
          lines: [{ productId: product.id, quantity: w.qty, selectedOptionIds: optionId ? [optionId] : [] }],
          now,
        });
      }
    }
  }

  await pool.end();
  console.log(`Showcase content seeded for '${slug}' ✓`);
}

main().catch((e) => { console.error(e); process.exit(1); });
