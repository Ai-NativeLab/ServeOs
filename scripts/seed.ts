import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });
import { eq, and, isNull } from "drizzle-orm";

// ── Roma demo content: pinned Unsplash imagery + menu data ──────────────────
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
  const { db, pool } = await import("../src/db/client");
  const { users, roles, userRoles } = await import("../src/server/auth/schema");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { hashPassword } = await import("../src/server/auth/password");
  const { seedDefaultPlans } = await import("../src/server/subscription");
  const { registerRestaurant } = await import("../src/server/onboarding");
  const { approveTenant } = await import("../src/server/platform");

  await seedDefaultPlans();

  // ── Platform super-admin ────────────────────────────────────────────────────
  const adminEmail = "admin@serveos.com";
  let [admin] = await db.select().from(users).where(and(eq(users.email, adminEmail), isNull(users.tenantId))).limit(1);
  if (!admin) {
    [admin] = await db
      .insert(users)
      .values({ tenantId: null, name: "Platform Admin", email: adminEmail, passwordHash: await hashPassword("admin1234") })
      .returning();
    const [role] = await db.insert(roles).values({ tenantId: null, key: "super_admin", name: "Super Admin" }).returning();
    await db.insert(userRoles).values({ userId: admin.id, roleId: role.id });
  }

  // ── Demo restaurant: Pizza Roma ─────────────────────────────────────────────
  const demoSlug = "roma";
  let [romaTenant] = await db.select().from(tenants).where(eq(tenants.slug, demoSlug)).limit(1);
  if (!romaTenant) {
    const demo = await registerRestaurant({
      restaurantName: "Pizza Roma",
      slug: demoSlug,
      country: "EG",
      ownerName: "Sam Adel",
      email: "owner@roma.com",
      password: "owner1234",
    });
    await approveTenant(demo.tenantId, admin.id);
    [romaTenant] = await db.select().from(tenants).where(eq(tenants.slug, demoSlug)).limit(1);
  }

  // ── Roma brand profile (tagline/cuisine/imagery) ────────────────────────────
  {
    const { updateTenantProfile } = await import("../src/server/tenancy/service");
    await updateTenantProfile(romaTenant.id, {
      tagline: "Wood-fired Italian, made fresh",
      cuisine: "Italian",
      coverImageUrl: IMG("1517248135467-4c7edcad34c4"),
      logoUrl: IMG("1552566626-52f8b828add9"),
    });
  }

  // ── Additional Roma staff ───────────────────────────────────────────────────
  // Ensure tenant-scoped role rows exist (idempotent)
  async function ensureTenantRole(tenantId: string, key: string, name: string) {
    let [role] = await db.select().from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.key, key))).limit(1);
    if (!role) {
      [role] = await db.insert(roles).values({ tenantId, key, name }).returning();
    }
    return role;
  }

  async function ensureUser(tenantId: string, email: string, name: string, password: string, roleKey: string, roleName: string) {
    let [user] = await db.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.email, email))).limit(1);
    if (!user) {
      [user] = await db
        .insert(users)
        .values({ tenantId, name, email, passwordHash: await hashPassword(password) })
        .returning();
      const role = await ensureTenantRole(tenantId, roleKey, roleName);
      await db.insert(userRoles).values({ userId: user.id, roleId: role.id });
    }
    return user;
  }

  await ensureUser(romaTenant.id, "manager@roma.com", "Nour Khalil", "manager1234", "manager", "Manager");
  await ensureUser(romaTenant.id, "staff@roma.com",   "Karim Nasser", "staff1234",   "staff",   "Staff");

  // ── Roma branch (idempotent) ────────────────────────────────────────────────
  {
    const { listBranches, createBranch } = await import("../src/server/branches/service");
    const branches = await listBranches(romaTenant.id);
    if (branches.length === 0) {
      await createBranch(romaTenant.id, { name: "Main Branch" });
    }
  }

  // ── Roma catalog: rich imaged menu (idempotent) ─────────────────────────────
  {
    const { listCategories, createCategory, createProduct, updateProduct,
            upsertModifierGroup, upsertModifierOption } = await import("../src/server/catalog/service");
    const { products: productsTable, categories: categoriesTable } = await import("../src/server/catalog/schema");
    const { withTenant } = await import("../src/db/with-tenant");

    // All tables here are RLS-protected (FORCE ROW LEVEL SECURITY), so any
    // direct db.* call MUST run inside withTenant — a bare db.select/update
    // outside of it sees zero rows (fails closed) rather than throwing.
    const existing = await listCategories(romaTenant.id);
    const existingNames = new Set(existing.map((c) => c.nameEn));
    const expectedNames = ROMA_MENU.map((e) => e.cat.nameEn);
    const hasFullMenu = expectedNames.every((n) => existingNames.has(n));

    if (!hasFullMenu) {
      // Clear stale/partial catalog rows (e.g. the old bare "Pizzas"/"Margherita"
      // demo data pre-dating this rich menu, or a previous incomplete run) so
      // the rich menu seeds cleanly. Products first (categories restrict
      // delete while referenced); modifier groups/options cascade off products.
      if (existing.length > 0) {
        await withTenant(romaTenant.id, async (tx) => {
          await tx.delete(productsTable).where(eq(productsTable.tenantId, romaTenant.id));
          await tx.delete(categoriesTable).where(eq(categoriesTable.tenantId, romaTenant.id));
        });
      }
      for (const entry of ROMA_MENU) {
        const cat = await createCategory(romaTenant.id, {
          nameEn: entry.cat.nameEn, nameAr: entry.cat.nameAr, imageUrl: IMG(entry.cat.img),
        });
        for (const pr of entry.products) {
          const p = await createProduct(romaTenant.id, {
            nameEn: pr.nameEn, nameAr: pr.nameAr, descriptionEn: pr.descEn, descriptionAr: pr.descEn,
            basePrice: pr.price, categoryId: cat.id, imageUrl: IMG(pr.img), isFeatured: !!pr.featured,
          });
          await updateProduct(romaTenant.id, p.id, { isPublished: true });
          if (pr.ageDays) {
            await withTenant(romaTenant.id, (tx) =>
              tx.update(productsTable)
                .set({ createdAt: new Date(Date.now() - pr.ageDays! * 24 * 60 * 60 * 1000) })
                .where(eq(productsTable.id, p.id)),
            );
          }
          if (["Pizza", "Pasta", "Drinks"].includes(entry.cat.nameEn)) {
            const g = await upsertModifierGroup(romaTenant.id, p.id, { nameEn: "Size", nameAr: "الحجم", required: true, minSelections: 1, maxSelections: 1 });
            await upsertModifierOption(romaTenant.id, g.id, { nameEn: "Regular", nameAr: "عادي", priceDelta: "0", isDefault: true });
            await upsertModifierOption(romaTenant.id, g.id, { nameEn: "Large", nameAr: "كبير", priceDelta: "35" });
          }
        }
      }
    }
  }

  // ── Roma banners (idempotent) ───────────────────────────────────────────────
  {
    const { listBanners, createBanner } = await import("../src/server/banners/service");
    if ((await listBanners(romaTenant.id)).length === 0) {
      await createBanner(romaTenant.id, {
        imageUrl: IMG("1513104890138-7c749659a591"),
        titleEn: "Wood-fired pizza, made fresh daily",
        titleAr: "بيتزا بالفرن الخشبي، طازجة يوميًا",
        sortOrder: 0,
      });
      await createBanner(romaTenant.id, {
        imageUrl: IMG("1551024601-bec78aea704b"),
        titleEn: "New: our Dolci selection",
        titleAr: "جديد: تشكيلة الحلويات",
        sortOrder: 1,
      });
      await createBanner(romaTenant.id, {
        imageUrl: IMG("1544025162-d76694265947"),
        titleEn: "Antipasto Misto — a table full of Italy",
        titleAr: "أنتيباستو ميستو — مائدة إيطالية كاملة",
        sortOrder: 2,
      });
    }
  }

  // ── Ordering demo data ──────────────────────────────────────────────────────
  {
    const { listBranches, updateBranchOrdering, listDeliveryAreas, createDeliveryArea } = await import("../src/server/branches/service");
    const { setVatRate } = await import("../src/server/tenancy/settings");
    const branches = await listBranches(romaTenant.id);
    if (branches[0]) {
      const b = branches[0];
      await updateBranchOrdering(romaTenant.id, b.id, {
        acceptingOrders: true,
        openingHours: Array.from({ length: 7 }, (_, day) => ({ day, open: "10:00", close: "23:00", closed: false })),
      });
      if ((await listDeliveryAreas(romaTenant.id, b.id)).length === 0) {
        await createDeliveryArea(romaTenant.id, b.id, { nameEn: "Maadi", nameAr: "المعادي", deliveryFee: "25", minOrderAmount: "100", etaMinutes: 35 });
        await createDeliveryArea(romaTenant.id, b.id, { nameEn: "Nasr City", nameAr: "مدينة نصر", deliveryFee: "40", minOrderAmount: "150", etaMinutes: 50 });
      }
    }
    await setVatRate(romaTenant.id, 14);
  }

  // ── Sample orders (a couple across statuses) ────────────────────────────────
  {
    const { listProducts } = await import("../src/server/catalog/service");
    const { listBranches, listDeliveryAreas } = await import("../src/server/branches/service");
    const { placeOrder, transitionStatus, listOrders } = await import("../src/server/ordering/service");

    const existing = await listOrders(romaTenant.id, { limit: 1 });
    const branch = (await listBranches(romaTenant.id))[0];
    const published = (await listProducts(romaTenant.id)).find((p) => p.isPublished);

    if (existing.length === 0 && branch && published) {
      // Fix the clock to mid-afternoon so the branch is always within hours,
      // regardless of when the seed actually runs.
      const now = new Date(); now.setHours(14, 0, 0, 0);
      const areas = await listDeliveryAreas(romaTenant.id, branch.id);

      if (areas[0]) {
        const o1 = await placeOrder(romaTenant.id, {
          branchId: branch.id, fulfillmentType: "delivery",
          customerName: "Ahmed Samir", customerPhone: "01000000001",
          areaId: areas[0].id, addressText: "12 St., Apt 4",
          lines: [{ productId: published.id, quantity: 2, selectedOptionIds: [] }],
          now,
        });
        await transitionStatus(romaTenant.id, o1.orderId, "confirmed", admin.id);
        await transitionStatus(romaTenant.id, o1.orderId, "preparing", admin.id);
      }

      // A pickup order left pending so the dashboard shows a "new" order.
      await placeOrder(romaTenant.id, {
        branchId: branch.id, fulfillmentType: "pickup",
        customerName: "Sara Hassan", customerPhone: "01000000002",
        lines: [{ productId: published.id, quantity: 1, selectedOptionIds: [] }],
        now,
      });
    }
  }

  // ── Popular-signal orders (so getPopularProductIds has clear winners) ──────
  {
    const { listBranches } = await import("../src/server/branches/service");
    const { listProducts, getProduct } = await import("../src/server/catalog/service");
    const { placeOrder } = await import("../src/server/ordering/service");
    const { orders: ordersTable } = await import("../src/server/ordering/schema");
    const { withTenant } = await import("../src/db/with-tenant");

    // Distinguishing marker so this block's idempotency is independent from the
    // "Sample orders" block above (which also writes to the orders table).
    // orders is RLS-protected (FORCE ROW LEVEL SECURITY), so this lookup must
    // run inside withTenant — a bare db.select would see zero rows regardless
    // of prior runs (fails closed), silently defeating this idempotency guard.
    const POPULAR_SIGNAL_PHONE = "01099998888";
    const marker = await withTenant(romaTenant.id, (tx) =>
      tx.select({ id: ordersTable.id }).from(ordersTable)
        .where(eq(ordersTable.customerPhone, POPULAR_SIGNAL_PHONE)).limit(1),
    );
    const branch = (await listBranches(romaTenant.id))[0];

    if (marker.length === 0 && branch) {
      const now = new Date(); now.setHours(14, 0, 0, 0);
      const allProducts = await listProducts(romaTenant.id);
      const byName = (nameEn: string) => allProducts.find((p) => p.nameEn === nameEn);

      async function regularOptionId(productId: string): Promise<string | undefined> {
        const full = await getProduct(romaTenant.id, productId);
        return full.modifierGroups.find((g) => g.nameEn === "Size")?.options.find((o) => o.nameEn === "Regular")?.id;
      }

      // The two featured pizzas/pasta hero dishes get the most volume; Caprese
      // trails behind so there's a visible ranking, not just a tie.
      const winners: Array<{ name: string; times: number; qty: number }> = [
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
          await placeOrder(romaTenant.id, {
            branchId: branch.id, fulfillmentType: "pickup",
            customerName: "Layla Fahmy", customerPhone: POPULAR_SIGNAL_PHONE,
            lines: [{ productId: product.id, quantity: w.qty, selectedOptionIds: optionId ? [optionId] : [] }],
            now,
          });
        }
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`
Seed complete — users created:

  PLATFORM
  ┌─ Super Admin   admin@serveos.com     / admin1234     → /admin/login

  PIZZA ROMA (slug: roma)
  ├─ Owner         owner@roma.com        / owner1234     → /login (slug: roma)
  ├─ Manager       manager@roma.com      / manager1234   → /login (slug: roma)
  └─ Staff         staff@roma.com        / staff1234     → /login (slug: roma)

  Storefront: http://roma.serveos.localhost:3000
  `);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
