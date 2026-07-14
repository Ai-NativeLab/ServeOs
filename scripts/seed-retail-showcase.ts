import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });
import { eq } from "drizzle-orm";

/**
 * Seeds a retail showcase tenant (slug: nobio) — hardware store with brands,
 * variants, and stock states. Idempotent: re-running wipes and recreates its
 * catalog only (the tenant, plan, subscription, branch, and delivery area are
 * created once and left alone on subsequent runs).
 *
 *   npx tsx scripts/seed-retail-showcase.ts
 */

type SeedVariant = { nameEn: string; nameAr: string; price: string; stock: number | null };
type SeedItem = {
  nameEn: string;
  nameAr: string;
  brand: string;
  price: string;
  stock?: number | null;
  variants?: SeedVariant[];
};
type SeedCategory = {
  cat: { nameEn: string; nameAr: string; img: string };
  items: SeedItem[];
};

const IMG = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;

async function main() {
  const { db } = await import("../src/db/client");
  const { withTenant } = await import("../src/db/with-tenant");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { categories, products, productVariants } = await import("../src/server/catalog/schema");
  const { seedDefaultPlans } = await import("../src/server/subscription/plans.seed");
  const { startTrial } = await import("../src/server/subscription/service");
  const { createBranch, updateBranchOrdering, createDeliveryArea } = await import("../src/server/branches/service");

  let [tenant] = await db.select().from(tenants).where(eq(tenants.slug, "nobio")).limit(1);
  if (!tenant) {
    [tenant] = await db
      .insert(tenants)
      .values({
        slug: "nobio",
        name: "Nobio Hardware",
        country: "EG",
        currency: "EGP",
        status: "active",
        vertical: "retail",
        tagline: "Fittings, worktops & hardware — delivered same day",
        cuisine: "Hardware & fittings", // rendered as "Store type" for retail
      })
      .returning();
    await seedDefaultPlans();
    await startTrial(tenant.id, "pro");
    const branch = await createBranch(tenant.id, { name: "Main Warehouse" });
    await updateBranchOrdering(tenant.id, branch.id, { acceptingOrders: true, openingHours: [] });
    await createDeliveryArea(tenant.id, branch.id, { nameEn: "Nasr City", nameAr: "مدينة نصر", deliveryFee: "40", minOrderAmount: "200" });
  }
  const tid = tenant.id;

  // wipe + recreate catalog (tenant-scoped)
  await withTenant(tid, async (tx) => {
    await tx.delete(productVariants);
    await tx.delete(products);
    await tx.delete(categories);
  });

  const CATALOG: SeedCategory[] = [
    { cat: { nameEn: "Hinges", nameAr: "مفصلات", img: IMG("1530124566582-a618bc2615dc") }, items: [
      { nameEn: "Soft-Close Hinge", nameAr: "مفصلة هادئة الغلق", brand: "Grimme", price: "50",
        variants: [
          { nameEn: "35mm", nameAr: "٣٥ مم", price: "55", stock: 40 },
          { nameEn: "40mm", nameAr: "٤٠ مم", price: "60", stock: 0 },
        ] },
      { nameEn: "Standard Hinge", nameAr: "مفصلة عادية", brand: "Egger", price: "22", stock: 120 },
    ] },
    { cat: { nameEn: "Handles", nameAr: "مقابض", img: IMG("1556228453-efd6c1ff04f6") }, items: [
      { nameEn: "Brushed Steel Handle", nameAr: "مقبض ستانلس", brand: "Grimme", price: "95",
        variants: [
          { nameEn: "128mm", nameAr: "١٢٨ مم", price: "95", stock: 25 },
          { nameEn: "192mm", nameAr: "١٩٢ مم", price: "120", stock: 12 },
          { nameEn: "256mm", nameAr: "٢٥٦ مم", price: "150", stock: null },
        ] },
      { nameEn: "Matte Black Knob", nameAr: "مقبض أسود مطفي", brand: "Nordform", price: "45", stock: 0 },
    ] },
    { cat: { nameEn: "Worktops", nameAr: "أسطح عمل", img: IMG("1600585154340-be6161a56a0c") }, items: [
      { nameEn: "Oak Compact Worktop", nameAr: "سطح عمل بلوط", brand: "Egger", price: "2400",
        variants: [
          { nameEn: "2400×600", nameAr: "٢٤٠٠×٦٠٠", price: "2400", stock: 6 },
          { nameEn: "3000×600", nameAr: "٣٠٠٠×٦٠٠", price: "2950", stock: 2 },
        ] },
    ] },
  ];

  for (const [ci, block] of CATALOG.entries()) {
    const cat = await withTenant(tid, async (tx) => {
      const [c] = await tx.insert(categories).values({ tenantId: tid, nameEn: block.cat.nameEn, nameAr: block.cat.nameAr, imageUrl: block.cat.img, sortOrder: ci }).returning();
      return c;
    });
    for (const [pi, item] of block.items.entries()) {
      const variants = item.variants;
      const hasVariants = variants !== undefined && variants.length > 0;
      const prod = await withTenant(tid, async (tx) => {
        const [p] = await tx.insert(products).values({
          tenantId: tid, categoryId: cat.id, nameEn: item.nameEn, nameAr: item.nameAr,
          brand: item.brand, basePrice: item.price, imageUrl: block.cat.img,
          isPublished: true, sortOrder: pi,
          trackStock: !hasVariants && item.stock !== undefined,
          stockQuantity: !hasVariants ? (item.stock ?? null) : null,
        }).returning();
        return p;
      });
      if (variants && variants.length > 0) {
        await withTenant(tid, async (tx) => {
          for (const [vi, v] of variants.entries()) {
            await tx.insert(productVariants).values({
              tenantId: tid, productId: prod.id, nameEn: v.nameEn, nameAr: v.nameAr,
              price: v.price, stockQuantity: v.stock, sortOrder: vi,
            });
          }
        });
      }
    }
  }
  console.log(`Seeded retail showcase: nobio (${tenant.id})`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
