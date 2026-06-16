import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });
import { eq, and, isNull } from "drizzle-orm";

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

  // ── Roma branch + catalog (idempotent) ─────────────────────────────────────
  {
    const { listBranches, createBranch } = await import("../src/server/branches/service");
    const { listCategories, createCategory, listProducts, createProduct, updateProduct } = await import("../src/server/catalog/service");

    let branches = await listBranches(romaTenant.id);
    if (branches.length === 0) {
      await createBranch(romaTenant.id, { name: "Main Branch" });
      branches = await listBranches(romaTenant.id);
    }

    const categories = await listCategories(romaTenant.id);
    let categoryId: string;
    if (categories.length === 0) {
      const cat = await createCategory(romaTenant.id, { nameEn: "Pizzas", nameAr: "بيتزا" });
      categoryId = cat.id;
    } else {
      categoryId = categories[0].id;
    }

    const products = await listProducts(romaTenant.id);
    if (products.length === 0) {
      const product = await createProduct(romaTenant.id, {
        nameEn: "Margherita",
        nameAr: "مارجريتا",
        basePrice: "89",
        categoryId,
      });
      await updateProduct(romaTenant.id, product.id, { isPublished: true });
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
