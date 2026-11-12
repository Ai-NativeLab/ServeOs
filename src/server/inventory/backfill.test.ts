import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { createBranch, updateBranchOrdering } from "@/server/branches/service";
import { createCategory, createProduct, updateProduct } from "@/server/catalog/service";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { placeOrder } from "@/server/ordering/service";
import { OutOfStockError } from "@/server/ordering/errors";
import { backfillTenant } from "../../../scripts/backfill-inventory";
import { productInventoryLinks, inventoryItems, stockLedger } from "./schema";
import { onHand, getOrCreateDefaultLocation } from "./service";

let n = 0;

describe("inventory backfill", () => {
  it("seeds an item + finished_good link + opening ledger whose on-hand equals the old integer", async () => {
    const { t, branch, product } = await seedFlat(7);

    const report = await backfillTenant(t.id);
    expect(report.productsSeeded).toBe(1);

    const links = await withTenant(t.id, (tx) => tx.select().from(productInventoryLinks));
    expect(links).toHaveLength(1);
    expect(links[0].productId).toBe(product.id);
    expect(links[0].linkType).toBe("finished_good");
    expect(links[0].itemId).toBeTruthy();

    const loc = await withTenant(t.id, (tx) => getOrCreateDefaultLocation(tx, t.id, branch.id, "retail"));
    expect(await onHand(t.id, links[0].itemId!, loc.id)).toBe(7);

    // The opening row must not look like a purchase in consumption/spend reports.
    const rows = await withTenant(t.id, (tx) => tx.select().from(stockLedger));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("adjustment");
    expect(rows[0].note).toBe("opening balance");

    const [item] = await withTenant(t.id, (tx) => tx.select().from(inventoryItems));
    expect(item.kind).toBe("finished_good");
    expect(item.baseUom).toBe("each");
  });

  it("is idempotent — a second run creates no duplicate links or lots", async () => {
    const { t } = await seedFlat(5);

    const first = await backfillTenant(t.id);
    const second = await backfillTenant(t.id);

    expect(first.productsSeeded).toBe(1);
    expect(second.productsSeeded).toBe(0);
    expect(second.skipped).toBe(1);

    const links = await withTenant(t.id, (tx) => tx.select().from(productInventoryLinks));
    const rows = await withTenant(t.id, (tx) => tx.select().from(stockLedger));
    expect(links).toHaveLength(1);
    expect(rows).toHaveLength(1); // no second opening balance
  });

  it("a sale post-backfill deducts identically to the pre-migration integer path", async () => {
    const { t, branch, product } = await seedFlat(7);
    await backfillTenant(t.id);
    const [link] = await withTenant(t.id, (tx) => tx.select().from(productInventoryLinks));
    const loc = await withTenant(t.id, (tx) => getOrCreateDefaultLocation(tx, t.id, branch.id, "retail"));

    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "01012345678",
      lines: [{ productId: product.id, quantity: 7, selectedOptionIds: [] }],
    });
    expect(await onHand(t.id, link.itemId!, loc.id)).toBe(0);

    // Retail still blocks past zero, exactly as the flat counter did.
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "B", customerPhone: "01012345679",
      lines: [{ productId: product.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OutOfStockError);
  });

  it("skips a product that is not tracking stock, leaving it an untracked sellable", async () => {
    const { t } = await seedFlat(null);
    const report = await backfillTenant(t.id);
    expect(report.productsSeeded).toBe(0);
    expect(await withTenant(t.id, (tx) => tx.select().from(productInventoryLinks))).toHaveLength(0);
  });

  it("seeds variants instead of the base product when the product has tracked variants", async () => {
    const { t, product } = await seedFlat(9);
    const { upsertVariant } = await import("@/server/catalog/variants");
    await upsertVariant(t.id, product.id, { nameEn: "35mm", nameAr: "٣٥مم", price: "55", stockQuantity: 3 });
    await upsertVariant(t.id, product.id, { nameEn: "40mm", nameAr: "٤٠مم", price: "60", stockQuantity: 4 });

    const report = await backfillTenant(t.id);
    // The base row is skipped so its 9 is not double-counted on top of 3 + 4.
    expect(report.productsSeeded).toBe(0);
    expect(report.variantsSeeded).toBe(2);

    const links = await withTenant(t.id, (tx) => tx.select().from(productInventoryLinks));
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.variantId !== null)).toBe(true);
  });
});

/** Seeds a retail tenant whose stock is still the legacy integer only. */
async function seedFlat(productQty: number | null) {
  const [t] = await db.insert(tenants).values({
    slug: `bf-${Date.now()}-${n++}`, name: "R", country: "EG", vertical: "retail",
  }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Hinges", nameAr: "مفصلات" });
  const product = await createProduct(t.id, { nameEn: "Hinge", nameAr: "مفصلة", basePrice: "50", categoryId: cat.id });
  await updateProduct(t.id, product.id, { isPublished: true });

  if (productQty !== null) {
    // Set the legacy columns directly: this is a tenant as it looked BEFORE the
    // migration, so it must have the integer and no ledger rows.
    const { products } = await import("@/server/catalog/schema");
    await withTenant(t.id, (tx) => tx.update(products)
      .set({ trackStock: true, stockQuantity: productQty })
      .where(and(eq(products.id, product.id), eq(products.tenantId, t.id))));
  }
  return { t, branch, product };
}
