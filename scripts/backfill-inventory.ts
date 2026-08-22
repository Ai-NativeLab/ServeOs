/**
 * Seeds the Spec 8 stock ledger from the legacy flat integer counter.
 *
 * Every product/variant that was tracking stock as a single global integer gets
 * an `inventory_item`, a `finished_good` `product_inventory_links` row, and one
 * opening-balance lot, so on-hand after the run equals the number it replaces.
 * Without this, an existing retail tenant would keep its integer but have no
 * link — and `placeOrder` deducts nothing for an unlinked sellable, so its stock
 * control would silently stop working.
 *
 * The opening ledger row is typed `adjustment` (note "opening balance"), never
 * `receive`, so a migration is not mistaken for a purchase in consumption or
 * spend reporting.
 *
 * Idempotent: a `(productId, variantId)` that already has a link is skipped, so
 * a re-run adds no duplicate items, links, or lots.
 *
 * PER-BRANCH COMPROMISE: the flat counter was one global number with no branch
 * dimension, so it cannot be split across branches without inventing data. The
 * opening balance therefore lands on the OLDEST branch's retail location, which
 * keeps tenant-wide on-hand exactly equal to the old integer. Other branches
 * start at zero and are reconciled by a physical stock count after go-live —
 * deliberately understating rather than duplicating the number across branches,
 * because an overstated shelf sells goods that do not exist. Multi-branch
 * tenants are listed in the run summary so an operator knows to count them.
 *
 * Run: ENV_FILE=.env.local npx tsx scripts/backfill-inventory.ts
 */
import { config } from "dotenv";

/**
 * True only when this file is the process entry point, i.e. someone ran
 * `tsx scripts/backfill-inventory.ts`. False when a test imports
 * backfillTenant from it.
 */
const RUN_DIRECTLY = process.argv[1]?.includes("backfill-inventory") ?? false;

// GUARDED, and it has to be. This call carries `override: true`, so on import
// it would replace a DATABASE_URL that vitest's setup had already pointed at
// .env.test with the one from .env.local — the developer's own database. The
// suite truncates every table before each test, so importing this script from
// a test wiped local data and left stray `bf-…` tenants behind. main() below
// was already guarded for the same reason; the env load was missed.
if (RUN_DIRECTLY) {
  config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });
}

import { asc, eq, isNotNull, and } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { products, productVariants } from "@/server/catalog/schema";
import { inventoryItems, productInventoryLinks } from "@/server/inventory/schema";
import { getOrCreateDefaultLocation, receiveStock } from "@/server/inventory/service";

export type BackfillReport = {
  tenantId: string;
  branchCount: number;
  productsSeeded: number;
  variantsSeeded: number;
  skipped: number;
};

export async function backfillTenant(tenantId: string): Promise<BackfillReport> {
  return withTenant(tenantId, async (tx) => {
    const tenantBranches = await tx.select().from(branches)
      .where(eq(branches.tenantId, tenantId)).orderBy(asc(branches.createdAt));

    const report: BackfillReport = {
      tenantId, branchCount: tenantBranches.length, productsSeeded: 0, variantsSeeded: 0, skipped: 0,
    };
    if (tenantBranches.length === 0) return report;

    // Finished-goods deduction always resolves the branch's RETAIL location
    // (see deductForOrderLine), so the opening balance must land there or a sale
    // would look at an empty shelf.
    const home = await getOrCreateDefaultLocation(tx, tenantId, tenantBranches[0].id, "retail");

    const existing = await tx.select({
      productId: productInventoryLinks.productId, variantId: productInventoryLinks.variantId,
    }).from(productInventoryLinks);
    const linked = new Set(existing.map((l) => `${l.productId}:${l.variantId ?? ""}`));

    const seed = async (args: {
      productId: string; variantId: string | null; nameEn: string; nameAr: string;
      sku: string | null; stockQuantity: number; unitCost: string | null;
    }): Promise<boolean> => {
      if (linked.has(`${args.productId}:${args.variantId ?? ""}`)) {
        report.skipped += 1;
        return false;
      }
      const [item] = await tx.insert(inventoryItems).values({
        tenantId, nameEn: args.nameEn, nameAr: args.nameAr, sku: args.sku,
        kind: "finished_good",
        baseUom: "each", stockUom: "each", purchaseUom: "each", recipeUom: "each",
        defaultUnitCost: args.unitCost,
      }).returning({ id: inventoryItems.id });

      await tx.insert(productInventoryLinks).values({
        tenantId, productId: args.productId, variantId: args.variantId,
        linkType: "finished_good", itemId: item.id,
      });
      linked.add(`${args.productId}:${args.variantId ?? ""}`);

      await receiveStock(tx, {
        tenantId, itemId: item.id, locationId: home.id,
        baseQty: args.stockQuantity, uom: "each",
        unitCost: args.unitCost ?? "0",
        ledgerType: "adjustment", note: "opening balance",
      });
      return true;
    };

    const tracked = await tx.select().from(products).where(and(
      eq(products.tenantId, tenantId), eq(products.trackStock, true), isNotNull(products.stockQuantity),
    ));
    for (const p of tracked) {
      // A variant-bearing product holds its stock on the variants, so seeding the
      // base row too would double-count it.
      const variants = await tx.select().from(productVariants).where(and(
        eq(productVariants.productId, p.id), isNotNull(productVariants.stockQuantity),
      ));
      if (variants.length > 0) continue;
      if (await seed({
        productId: p.id, variantId: null, nameEn: p.nameEn, nameAr: p.nameAr, sku: p.sku,
        stockQuantity: p.stockQuantity ?? 0, unitCost: null,
      })) report.productsSeeded += 1;
    }

    const trackedVariants = await tx.select({
      id: productVariants.id, productId: productVariants.productId,
      nameEn: productVariants.nameEn, nameAr: productVariants.nameAr,
      sku: productVariants.sku, stockQuantity: productVariants.stockQuantity,
      price: productVariants.price,
    }).from(productVariants).where(and(
      eq(productVariants.tenantId, tenantId), isNotNull(productVariants.stockQuantity),
    ));
    for (const v of trackedVariants) {
      if (await seed({
        productId: v.productId, variantId: v.id, nameEn: v.nameEn, nameAr: v.nameAr, sku: v.sku,
        stockQuantity: v.stockQuantity ?? 0, unitCost: null,
      })) report.variantsSeeded += 1;
    }

    return report;
  });
}

async function main(): Promise<void> {
  const all = await db.select({ id: tenants.id, slug: tenants.slug }).from(tenants);
  const multiBranch: string[] = [];
  let items = 0;

  for (const t of all) {
    const r = await backfillTenant(t.id);
    items += r.productsSeeded + r.variantsSeeded;
    if (r.productsSeeded + r.variantsSeeded + r.skipped > 0) {
      console.log(
        `${t.slug}: ${r.productsSeeded} product(s), ${r.variantsSeeded} variant(s) seeded, ${r.skipped} already linked`,
      );
    }
    if (r.branchCount > 1 && r.productsSeeded + r.variantsSeeded > 0) multiBranch.push(t.slug);
  }

  console.log(`\nseeded ${items} inventory item(s) across ${all.length} tenant(s)`);
  if (multiBranch.length > 0) {
    console.log(
      `\nNEEDS A STOCK COUNT — opening balances landed on the oldest branch only, ` +
      `so other branches start at zero:\n  ${multiBranch.join("\n  ")}`,
    );
  }
}

// Only run when invoked directly, so the test suite can import backfillTenant.
if (RUN_DIRECTLY) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
