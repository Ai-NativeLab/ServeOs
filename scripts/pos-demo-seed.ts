/**
 * Seeds a demo tenant + branch + published menu and mints a long-lived POS
 * pairing code, for end-to-end testing of the desktop POS.
 *
 * Run against the TEST database (never prod):
 *   ENV_FILE=.env.test tsx scripts/pos-demo-seed.ts
 *
 * Idempotent: reuses the demo tenant/branch/menu if already present; always
 * prints a fresh 24-hour pairing code.
 */
import { config } from "dotenv";
import { randomBytes } from "node:crypto";

config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

const DEMO_SLUG = "posdemo";
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function code8(): string {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

async function main() {
  // Dynamic import so dotenv runs before db/client reads DATABASE_URL.
  const { db, pool } = await import("../src/db/client");
  const { eq } = await import("drizzle-orm");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { users } = await import("../src/server/auth/schema");
  const { posPairingCodes } = await import("../src/server/pos/schema");
  const { seedDefaultPlans } = await import("../src/server/subscription/plans.seed");
  const { startTrial } = await import("../src/server/subscription/service");
  const { createBranch, updateBranchOrdering, listBranches } = await import("../src/server/branches/service");
  const {
    createCategory, createProduct, updateProduct, upsertModifierGroup, upsertModifierOption, listProducts,
  } = await import("../src/server/catalog/service");

  // 1. Tenant (reuse if present).
  let [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEMO_SLUG)).limit(1);
  if (!tenant) {
    [tenant] = await db.insert(tenants).values({ slug: DEMO_SLUG, name: "POS Demo Diner", country: "EG" }).returning();
    await seedDefaultPlans();
    await startTrial(tenant.id, "pro");
    console.log(`created tenant "${DEMO_SLUG}"`);
  } else {
    console.log(`reusing tenant "${DEMO_SLUG}"`);
  }

  // 2. User (for pairing-code authorship).
  let [user] = await db.select().from(users).where(eq(users.tenantId, tenant.id)).limit(1);
  if (!user) {
    [user] = await db.insert(users).values({ tenantId: tenant.id, name: "Demo Owner" }).returning();
  }

  // 3. Branch (accepting orders).
  let [branch] = await listBranches(tenant.id);
  if (!branch) {
    branch = await createBranch(tenant.id, { name: "Main Counter" });
    await updateBranchOrdering(tenant.id, branch.id, { acceptingOrders: true, openingHours: [] });
    console.log("created branch \"Main Counter\"");
  }

  // 4. Menu (only if empty).
  const existingProducts = await listProducts(tenant.id);
  if (existingProducts.length === 0) {
    const pizzas = await createCategory(tenant.id, { nameEn: "Pizzas", nameAr: "بيتزا" });
    const drinks = await createCategory(tenant.id, { nameEn: "Drinks", nameAr: "مشروبات" });

    const margherita = await createProduct(tenant.id, {
      nameEn: "Margherita", nameAr: "مارجريتا", basePrice: "80", categoryId: pizzas.id,
    });
    await updateProduct(tenant.id, margherita.id, { isPublished: true });
    const extras = await upsertModifierGroup(tenant.id, margherita.id, {
      nameEn: "Extras", nameAr: "إضافات", required: false, minSelections: 0, maxSelections: 2,
    });
    await upsertModifierOption(tenant.id, extras.id, { nameEn: "Extra cheese", nameAr: "جبنة إضافية", priceDelta: "15" });
    await upsertModifierOption(tenant.id, extras.id, { nameEn: "Mushrooms", nameAr: "مشروم", priceDelta: "10" });

    const pepperoni = await createProduct(tenant.id, {
      nameEn: "Pepperoni", nameAr: "بيبروني", basePrice: "95", categoryId: pizzas.id,
    });
    await updateProduct(tenant.id, pepperoni.id, { isPublished: true });

    const cola = await createProduct(tenant.id, {
      nameEn: "Cola", nameAr: "كولا", basePrice: "20", categoryId: drinks.id,
    });
    await updateProduct(tenant.id, cola.id, { isPublished: true });
    console.log("seeded menu: Margherita (+extras), Pepperoni, Cola");
  } else {
    console.log(`reusing existing menu (${existingProducts.length} products)`);
  }

  // 5. Fresh pairing code, valid 24h (long-lived for convenient testing).
  const code = code8();
  await db.insert(posPairingCodes).values({
    tenantId: tenant.id,
    branchId: branch.id,
    code,
    label: "Demo terminal",
    createdByUserId: user.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  console.log("\n────────────────────────────────────────");
  console.log(`  PAIRING CODE:  ${code}`);
  console.log(`  branch:        ${branch.name}`);
  console.log(`  valid for:     24 hours`);
  console.log("────────────────────────────────────────\n");

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
