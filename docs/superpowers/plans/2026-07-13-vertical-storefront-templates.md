# Vertical Storefront Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ServeOS vertical-aware: a typed vertical registry (restaurant, retail, pharmacy, timber) drives storefront template choice, terminology, capability-gated catalog behavior (variants + stock for shop verticals), and vertical-aware checkout adjustments (VAT + service charge), per the approved spec `docs/superpowers/specs/2026-07-13-vertical-storefront-templates-design.md` (see its Revision 2).

**Architecture:** A pure (no-DB) `src/server/verticals/` registry exports descriptors; the merged `tenants.vertical` pg enum selects one. Shared services branch on **capabilities only** — never on vertical names. The storefront routes per vertical through the merged `StorefrontShell` wrappers; shop verticals swap the catalog slot for the new shop UI. One pure function `computeOrderTotals` in `src/lib/` is the single money computation, used by `placeOrder` server-side and by checkout for display.

**Tech Stack:** Next.js 16 App Router (async `headers()`/`params` — follow existing codebase patterns, NOT training data; see `AGENTS.md`), Drizzle + Supabase Postgres with FORCE RLS via `withTenant()`, Vitest (integration tests hit the `serveos_test` DB), Playwright.

## Revision 2 (2026-07-14)

The branch is rebased onto `origin/main`, which now contains the merged multi-vertical
scaffold (`vertical` enum + `tenants.vertical` column via `0014_melodic_polaris`,
`registerTenant` + register picker with tests, per-vertical template routing over
`StorefrontShell`, `src/server/tenancy/verticals.ts`). Tasks 1, 2, 8, 9, and 11 are
revised in place to build on it. Renames relative to the original text everywhere: the
vertical type is **`VerticalId`** with values `restaurant | retail | pharmacy | timber`
(the name `VerticalKey` must not appear anywhere; no new `tenant_vertical` enum); onboarding's entry point is
**`registerTenant`**. Pharmacy and timber are shop-template verticals with retail-like
capabilities in v1 (their prescription / cut-to-order domains stay out of scope).

## Global Constraints

- Branch: `feat/vertical-storefront-templates`, rebased onto origin/main's scaffold.
- **Single source of truth:** `src/server/verticals/` absorbs and deletes
  `src/server/tenancy/verticals.ts`, preserving its export names (`VERTICAL_IDS`,
  `VERTICAL_ACCENTS`, `VERTICAL_STOREFRONT_COPY`, `selectStorefrontTemplate`,
  `VerticalId`, `VerticalStorefrontCopy`) as derivations of the descriptors. No file may
  define vertical facts outside the registry (the marketing landing's
  `src/app/_components/marketing/verticals.ts` is landing copy, not behavior, and stays).
- Shared services must branch on `capabilities.<flag>`, never `tenant.vertical === "..."`. Only the registry, the storefront dispatcher, and dashboard template dispatch may mention vertical keys.
- Existing restaurant tenants must see **zero behavior change**: `vertical` defaults to `restaurant`, `track_stock` defaults to `false`, checkout pricing defaults preserve today's totals (VAT on, exclusive, no service charge).
- All new tenant-scoped tables get `tenant_id` + ENABLE/FORCE ROW LEVEL SECURITY + the standard isolation policy (copy the exact SQL shape from `drizzle/0007_bitter_mandarin.sql`).
- Money is stored as Postgres `numeric` via strings; use the existing `money()` helper (`src/server/ordering/service.ts:31`) for DB writes and `formatMoney()` (`src/lib/money.ts`) for display. Unit prices always come from the DB, never the client.
- Bilingual copy: every user-facing label added has `en` + `ar` variants (existing `nameEn`/`nameAr` convention; `DomainError.messageFor(locale)`).
- Tests: `npm run test -- <path>` (Vitest; requires `serveos_test` DB migrated via `npm run db:migrate:test`). E2E: `npm run test:e2e -- <path>` (requires dev DB seeded and dev server buildable).
- Commit after every task (conventional commits, as in `git log`).

## File Structure (what exists / what's new)

```
src/server/verticals/            NEW single source of truth: types.ts, registry.ts, errors.ts, index.ts
src/server/tenancy/verticals.ts  DELETE (absorbed); call sites re-pointed (+ its test absorbed)
src/server/tenancy/settings.ts   MODIFY: vatEnabled/pricesIncludeVat/serviceChargeRate + getCheckoutPricing
src/server/catalog/schema.ts     MODIFY: products cols; NEW product_variants table
src/server/catalog/variants.ts   NEW: variant CRUD + stock setters (capability-gated)
src/server/catalog/service.ts    MODIFY: gate modifiers; extend product inputs; publish variants
src/server/catalog/errors.ts     MODIFY: InvalidVariantError
src/server/ordering/schema.ts    MODIFY: orders.service_charge_amount; order_items variant cols
src/server/ordering/service.ts   MODIFY: computeOrderTotals use; variant lines; stock decrement/restock
src/server/ordering/errors.ts    MODIFY: OutOfStockError
src/lib/order-totals.ts          NEW pure totals function (client-safe)
src/app/_components/cart.ts      MODIFY: variant-aware CartLine + merge
src/app/_components/storefront/templates/StorefrontShell.tsx  MODIFY: catalog slot
src/app/_components/storefront/templates/{Retail,Pharmacy,Timber}Storefront.tsx MODIFY: shop catalog
src/app/_components/storefront/templates/shop/ShopBrowser.tsx NEW (client: search/grid/sheet/cart)
src/app/_components/storefront/templates/shop/ShopProductCard.tsx NEW
src/app/_components/storefront/templates/shop/RetailProductSheet.tsx NEW
src/app/_components/storefront/templates/shop/shop-search.ts NEW (+ test)
src/app/page.tsx                 MODIFY: terms-driven empty states (routing already merged)
src/app/checkout/page.tsx        MODIFY: pass CheckoutPricing
src/app/checkout/CheckoutForm.tsx MODIFY: totals breakdown, variant lines, out-of-stock error
src/app/api/orders/route.ts      MODIFY: variantId in line allowlist
src/lib/order-status.ts          MODIFY: label overrides for pack/collect language
src/app/order/[token]/page.tsx   MODIFY: vertical status labels
src/server/platform/* + src/app/admin/page.tsx MODIFY: show vertical in queue
src/components/dashboard/nav-items.ts MODIFY: catalog label param
src/app/dashboard/layout.tsx     MODIFY: pass vertical terms
src/app/dashboard/menu/products/[id]/page.tsx MODIFY: capability-adaptive form + variants editor
src/app/dashboard/menu/products/actions.ts MODIFY: retail fields + variant actions
src/app/dashboard/menu/page.tsx  MODIFY: stock quick-adjust (shop verticals)
src/app/dashboard/settings/tabs.ts + settings/taxes/* NEW tab
src/app/dashboard/page.tsx       MODIFY: storefront QR card
scripts/seed-retail-showcase.ts  NEW retail demo tenant
tests/e2e/shop.spec.ts           NEW shop smoke
```

---

### Task 1 (REVISED): Unified verticals registry — absorbs `src/server/tenancy/verticals.ts`

**Files:**
- Create: `src/server/verticals/types.ts`
- Create: `src/server/verticals/registry.ts`
- Create: `src/server/verticals/errors.ts`
- Create: `src/server/verticals/index.ts`
- Delete: `src/server/tenancy/verticals.ts` and `src/server/tenancy/verticals.test.ts` (their content is absorbed)
- Modify: every importer of `@/server/tenancy/verticals` — find them with `grep -rl "tenancy/verticals" src/ scripts/ --include="*.ts*"` (expected: `src/server/onboarding/service.ts`, `src/server/onboarding/service.test.ts`, `src/app/register/actions.ts`, `src/app/register/RegisterForm.tsx`, `src/app/page.tsx`, `src/app/_components/storefront/templates/StorefrontShell.tsx` and the four wrapper templates) — change the import path to `@/server/verticals`; no other change, the export names are preserved.
- Test: `src/server/verticals/registry.test.ts`

**Interfaces:**
- Consumes: `DomainError`, `Locale` from `@/shared/errors` (exists).
- Produces (used by later tasks): `VerticalId` (4 values), `VERTICAL_IDS`, `VerticalCapabilities`, `VerticalTerms`, `VerticalDescriptor`, `AdjustmentKind`; `getVerticalDescriptor(key: VerticalId)`; `getCapabilities(key: VerticalId)`; `getVerticalTerms(key: VerticalId)`; `requireCapability(key: VerticalId, cap: keyof VerticalCapabilities): void` (throws `CapabilityNotEnabledError`).
- Compat (preserved for the merged scaffold's call sites): `VERTICAL_ACCENTS`, `VERTICAL_STOREFRONT_COPY`, `VerticalStorefrontCopy`, `selectStorefrontTemplate` — all **derived from the descriptors**, never hand-maintained.

- [ ] **Step 1: Write the failing test** — this absorbs the assertions of the deleted `src/server/tenancy/verticals.test.ts` (accents distinct, WhatsApp restaurant-only, template fallback) so no coverage is lost:

```ts
// src/server/verticals/registry.test.ts
import { describe, it, expect } from "vitest";
import {
  VERTICAL_IDS, getVerticalDescriptor, getCapabilities, getVerticalTerms, requireCapability,
  VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY, selectStorefrontTemplate, type VerticalId,
} from "./registry";
import { CapabilityNotEnabledError } from "./errors";

describe("vertical registry", () => {
  it("defines a complete descriptor for every vertical (fails when a vertical is half-added)", () => {
    expect(VERTICAL_IDS).toEqual(["restaurant", "retail", "pharmacy", "timber"]);
    for (const key of VERTICAL_IDS) {
      const d = getVerticalDescriptor(key);
      expect(d.key).toBe(key);
      expect(["menu", "shop"]).toContain(d.storefront.template);
      expect(d.accent).toMatch(/^#[0-9A-Fa-f]{6}$/);
      // every terminology label has non-empty en + ar
      for (const [term, label] of Object.entries(d.terminology)) {
        expect(label.en, `${key}.${term}.en`).toBeTruthy();
        expect(label.ar, `${key}.${term}.ar`).toBeTruthy();
      }
      // serviceCharge capability must match the declared adjustments
      expect(d.checkout.adjustments.includes("service_charge")).toBe(d.capabilities.serviceCharge);
      expect(d.checkout.adjustments.includes("vat")).toBe(true);
    }
  });

  it("restaurant: modifiers on, variants/stock off, menu template", () => {
    const caps = getCapabilities("restaurant");
    expect(caps).toEqual({ modifiers: true, variants: false, stockTracking: false, serviceCharge: true });
    expect(getVerticalDescriptor("restaurant").storefront.template).toBe("menu");
  });

  it("retail, pharmacy, timber: variants/stock on, modifiers off, shop template", () => {
    for (const key of ["retail", "pharmacy", "timber"] as VerticalId[]) {
      const caps = getCapabilities(key);
      expect(caps, key).toEqual({ modifiers: false, variants: true, stockTracking: true, serviceCharge: false });
      expect(getVerticalDescriptor(key).storefront.template, key).toBe("shop");
    }
  });

  it("terminology differs where it matters", () => {
    expect(getVerticalTerms("restaurant").catalogNoun.en).toBe("Menu");
    expect(getVerticalTerms("retail").catalogNoun.en).toBe("Products");
    expect(getVerticalTerms("timber").storefrontHeading.en).toBe("Yard");
  });

  it("requireCapability throws a typed error for a disabled capability", () => {
    expect(() => requireCapability("retail", "modifiers")).toThrow(CapabilityNotEnabledError);
    expect(() => requireCapability("restaurant", "modifiers")).not.toThrow();
  });

  // ── absorbed from src/server/tenancy/verticals.test.ts ──
  it("defines the four trades with distinct accents", () => {
    expect(new Set(Object.values(VERTICAL_ACCENTS)).size).toBe(4);
  });

  it("only the restaurant shows the WhatsApp CTA", () => {
    (Object.keys(VERTICAL_STOREFRONT_COPY) as VerticalId[]).forEach((v) => {
      expect(VERTICAL_STOREFRONT_COPY[v].showWhatsapp).toBe(v === "restaurant");
    });
  });

  it("selectStorefrontTemplate falls back to restaurant for unknown values", () => {
    expect(selectStorefrontTemplate("retail")).toBe("retail");
    expect(selectStorefrontTemplate(null)).toBe("restaurant");
    expect(selectStorefrontTemplate("bogus" as VerticalId)).toBe("restaurant");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/server/verticals/registry.test.ts`
Expected: FAIL — cannot resolve `./registry`.

- [ ] **Step 3: Write the module**

```ts
// src/server/verticals/types.ts
export const VERTICAL_IDS = ["restaurant", "retail", "pharmacy", "timber"] as const;
export type VerticalId = (typeof VERTICAL_IDS)[number];

export type VerticalCapabilities = {
  modifiers: boolean;
  variants: boolean;
  stockTracking: boolean;
  serviceCharge: boolean;
};

export type LocalizedLabel = { en: string; ar: string };

export type VerticalTerms = {
  businessNoun: LocalizedLabel;      // "restaurant" / "store" / "pharmacy" / "yard"
  catalogNoun: LocalizedLabel;       // dashboard nav: "Menu" / "Products" / "Products" / "Yard"
  storefrontHeading: LocalizedLabel; // storefront section: "Menu" / "Shop" / "Shop" / "Yard"
  businessTypeLabel: LocalizedLabel; // "Cuisine" / "Store type" / "Store type" / "Yard type"
  notFoundTitle: LocalizedLabel;     // storefront: unknown slug
  gettingReadyBody: LocalizedLabel;  // storefront: tenant not servable
  emptyCatalogTitle: LocalizedLabel; // "Menu coming soon" / "Catalog coming soon" / ...
  emptyCatalogBody: LocalizedLabel;
  statusPreparing: LocalizedLabel;   // "Preparing" / "Being packed"
  statusReady: LocalizedLabel;       // "Ready" / "Ready for collection"
};

export type AdjustmentKind = "vat" | "service_charge";

export type VerticalDescriptor = {
  key: VerticalId;
  accent: string; // hex, shared with the marketing landing tokens
  capabilities: VerticalCapabilities;
  terminology: VerticalTerms;
  storefront: { template: "menu" | "shop"; showWhatsapp: boolean };
  checkout: { adjustments: AdjustmentKind[] };
};

/** Compat shape consumed by the merged StorefrontShell (derived, never hand-written). */
export type VerticalStorefrontCopy = {
  menuHeading: string;
  showWhatsapp: boolean;
  emptyMenuTitle: string;
  emptyMenuDesc: string;
};
```

```ts
// src/server/verticals/errors.ts
import { DomainError, type Locale } from "@/shared/errors";

export class CapabilityNotEnabledError extends DomainError {
  readonly code = "capability_not_enabled";
  constructor(readonly capability: string) {
    super(`Capability not enabled: ${capability}`);
    this.name = "CapabilityNotEnabledError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "هذه الميزة غير متاحة لنوع نشاطك" : "This feature is not available for your business type";
  }
}
```

```ts
// src/server/verticals/registry.ts
import { VERTICAL_IDS, type VerticalCapabilities, type VerticalDescriptor, type VerticalId, type VerticalStorefrontCopy, type VerticalTerms } from "./types";
import { CapabilityNotEnabledError } from "./errors";

const restaurant: VerticalDescriptor = {
  key: "restaurant",
  accent: "#F0522B",
  capabilities: { modifiers: true, variants: false, stockTracking: false, serviceCharge: true },
  terminology: {
    businessNoun: { en: "restaurant", ar: "مطعم" },
    catalogNoun: { en: "Menu", ar: "القائمة" },
    storefrontHeading: { en: "Menu", ar: "القائمة" },
    businessTypeLabel: { en: "Cuisine", ar: "نوع المطبخ" },
    notFoundTitle: { en: "Restaurant not found", ar: "المطعم غير موجود" },
    gettingReadyBody: { en: "This restaurant is getting ready. Check back soon!", ar: "المطعم قيد التجهيز، عد قريباً!" },
    // Empty-catalog copy must stay byte-identical to the merged
    // VERTICAL_STOREFRONT_COPY values — the storefront shell renders it today.
    emptyCatalogTitle: { en: "Menu coming soon", ar: "القائمة قريباً" },
    emptyCatalogBody: { en: "This restaurant hasn't published a menu yet.", ar: "لم ينشر هذا المطعم قائمته بعد." },
    // Must equal the current labels in src/lib/order-status.ts —
    // restaurant tenants see byte-identical status copy after this change.
    statusPreparing: { en: "Preparing", ar: "قيد التحضير" },
    statusReady: { en: "Ready", ar: "جاهز" },
  },
  storefront: { template: "menu", showWhatsapp: true },
  checkout: { adjustments: ["vat", "service_charge"] },
};

const retail: VerticalDescriptor = {
  key: "retail",
  accent: "#2DD4C4",
  capabilities: { modifiers: false, variants: true, stockTracking: true, serviceCharge: false },
  terminology: {
    businessNoun: { en: "store", ar: "متجر" },
    catalogNoun: { en: "Products", ar: "المنتجات" },
    storefrontHeading: { en: "Shop", ar: "المتجر" },
    businessTypeLabel: { en: "Store type", ar: "نوع المتجر" },
    notFoundTitle: { en: "Store not found", ar: "المتجر غير موجود" },
    gettingReadyBody: { en: "This store is getting ready. Check back soon!", ar: "المتجر قيد التجهيز، عد قريباً!" },
    emptyCatalogTitle: { en: "Catalog coming soon", ar: "الكتالوج قريباً" },
    emptyCatalogBody: { en: "This shop hasn't published its catalog yet.", ar: "لم ينشر هذا المتجر كتالوجه بعد." },
    statusPreparing: { en: "Being packed", ar: "قيد التجهيز" },
    statusReady: { en: "Ready for collection", ar: "جاهز للاستلام" },
  },
  storefront: { template: "shop", showWhatsapp: false },
  checkout: { adjustments: ["vat"] },
};

const pharmacy: VerticalDescriptor = {
  key: "pharmacy",
  accent: "#38D08C",
  capabilities: { modifiers: false, variants: true, stockTracking: true, serviceCharge: false },
  terminology: {
    businessNoun: { en: "pharmacy", ar: "صيدلية" },
    catalogNoun: { en: "Products", ar: "المنتجات" },
    storefrontHeading: { en: "Shop", ar: "المتجر" },
    businessTypeLabel: { en: "Store type", ar: "نوع المتجر" },
    notFoundTitle: { en: "Pharmacy not found", ar: "الصيدلية غير موجودة" },
    gettingReadyBody: { en: "This pharmacy is getting ready. Check back soon!", ar: "الصيدلية قيد التجهيز، عد قريباً!" },
    emptyCatalogTitle: { en: "Catalog coming soon", ar: "الكتالوج قريباً" },
    emptyCatalogBody: { en: "This pharmacy hasn't published its catalog yet.", ar: "لم تنشر هذه الصيدلية كتالوجها بعد." },
    statusPreparing: { en: "Being packed", ar: "قيد التجهيز" },
    statusReady: { en: "Ready for collection", ar: "جاهز للاستلام" },
  },
  storefront: { template: "shop", showWhatsapp: false },
  checkout: { adjustments: ["vat"] },
};

const timber: VerticalDescriptor = {
  key: "timber",
  accent: "#E8A33D",
  capabilities: { modifiers: false, variants: true, stockTracking: true, serviceCharge: false },
  terminology: {
    businessNoun: { en: "yard", ar: "منشرة" },
    catalogNoun: { en: "Yard", ar: "المخزون" },
    storefrontHeading: { en: "Yard", ar: "المخزون" },
    businessTypeLabel: { en: "Yard type", ar: "نوع المنشرة" },
    notFoundTitle: { en: "Yard not found", ar: "المنشرة غير موجودة" },
    gettingReadyBody: { en: "This yard is getting ready. Check back soon!", ar: "المنشرة قيد التجهيز، عد قريباً!" },
    emptyCatalogTitle: { en: "Yard list coming soon", ar: "قائمة المخزون قريباً" },
    emptyCatalogBody: { en: "This yard hasn't published its stock list yet.", ar: "لم تنشر هذه المنشرة قائمة مخزونها بعد." },
    statusPreparing: { en: "Being packed", ar: "قيد التجهيز" },
    statusReady: { en: "Ready for collection", ar: "جاهز للاستلام" },
  },
  storefront: { template: "shop", showWhatsapp: false },
  checkout: { adjustments: ["vat"] },
};

const REGISTRY: Record<VerticalId, VerticalDescriptor> = { restaurant, retail, pharmacy, timber };

export { VERTICAL_IDS };

export function getVerticalDescriptor(key: VerticalId): VerticalDescriptor {
  return REGISTRY[key];
}
export function getCapabilities(key: VerticalId): VerticalCapabilities {
  return REGISTRY[key].capabilities;
}
export function getVerticalTerms(key: VerticalId): VerticalTerms {
  return REGISTRY[key].terminology;
}
/** Throws CapabilityNotEnabledError when the vertical lacks the capability. */
export function requireCapability(key: VerticalId, capability: keyof VerticalCapabilities): void {
  if (!REGISTRY[key].capabilities[capability]) throw new CapabilityNotEnabledError(capability);
}

// ── compat exports for the merged scaffold (derived from descriptors) ─────────

export const VERTICAL_ACCENTS: Record<VerticalId, string> = Object.fromEntries(
  VERTICAL_IDS.map((k) => [k, REGISTRY[k].accent]),
) as Record<VerticalId, string>;

export const VERTICAL_STOREFRONT_COPY: Record<VerticalId, VerticalStorefrontCopy> = Object.fromEntries(
  VERTICAL_IDS.map((k) => {
    const d = REGISTRY[k];
    return [k, {
      menuHeading: d.terminology.storefrontHeading.en,
      showWhatsapp: d.storefront.showWhatsapp,
      emptyMenuTitle: d.terminology.emptyCatalogTitle.en,
      emptyMenuDesc: d.terminology.emptyCatalogBody.en,
    }];
  }),
) as Record<VerticalId, VerticalStorefrontCopy>;

/** Resolve the storefront template for a tenant's vertical. Unknown → restaurant. */
export function selectStorefrontTemplate(vertical: VerticalId | null | undefined): VerticalId {
  return vertical && (VERTICAL_IDS as readonly string[]).includes(vertical) ? vertical : "restaurant";
}
```

```ts
// src/server/verticals/index.ts
export {
  VERTICAL_IDS,
  type VerticalId, type VerticalCapabilities, type VerticalTerms, type VerticalDescriptor,
  type AdjustmentKind, type LocalizedLabel, type VerticalStorefrontCopy,
} from "./types";
export {
  getVerticalDescriptor, getCapabilities, getVerticalTerms, requireCapability,
  VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY, selectStorefrontTemplate,
} from "./registry";
export { CapabilityNotEnabledError } from "./errors";
```

- [ ] **Step 3b: Re-point call sites and delete the absorbed module** — run `grep -rl "tenancy/verticals" src/ scripts/ --include="*.ts" --include="*.tsx"`, change each import path to `@/server/verticals` (export names are identical, so nothing else changes), then `git rm src/server/tenancy/verticals.ts src/server/tenancy/verticals.test.ts`. Re-run the grep — it must return nothing.

- [ ] **Step 4: Run the registry test, then the full suite**

Run: `npm run test -- src/server/verticals/registry.test.ts`
Expected: PASS (8 tests).
Then: `npx tsc --noEmit && npm run test`
Expected: PASS — the merged scaffold's tests (onboarding, platform, marketing e2e excluded here) still pass against the re-pointed imports.

- [ ] **Step 5: Commit**

```bash
git add -A src/server/verticals src/server/tenancy src/server/onboarding src/app
git commit -m "feat(verticals): unified registry (capabilities+terms+checkout) absorbing tenancy/verticals as single source of truth"
```

---

### Task 2 (REVISED): Schema — product_variants, retail/order columns + RLS migration

**Files:**
- Modify: `src/server/catalog/schema.ts`
- Modify: `src/server/ordering/schema.ts`
- Create: `drizzle/00XX_*.sql` (generated, then edited to append RLS)
- Test: `src/server/catalog/variants-rls.test.ts`

**Interfaces:**
- Consumes: the merged `tenants.vertical` column (enum `vertical`, 4 values, default `restaurant` — already in `0014_melodic_polaris.sql`; do NOT create any tenant enum/column here).
- Produces: `productVariants` table + `ProductVariant`/`NewProductVariant` types; `products.brand/sku/stockQuantity/trackStock`; `orders.serviceChargeAmount` (nullable numeric); `orderItems.variantId/variantNameEn/variantNameAr` (nullable).

- [ ] **Step 1: (removed — `tenants.vertical` already merged via the scaffold's migration)**

- [ ] **Step 2: Add retail columns + product_variants to catalog** — in `src/server/catalog/schema.ts`, inside `products` after `imageUrl`:

```ts
  brand: text("brand"),
  sku: text("sku"),
  trackStock: boolean("track_stock").notNull().default(false),
  stockQuantity: integer("stock_quantity"),
```

and after the `products` table:

```ts
export const productVariants = pgTable("product_variants", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  nameEn: text("name_en").notNull(),
  nameAr: text("name_ar").notNull(),
  sku: text("sku"),
  // Absolute price: a variant is a purchasable unit, not a delta on basePrice.
  price: numeric("price").notNull(),
  // null = not tracked (always purchasable).
  stockQuantity: integer("stock_quantity"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export type ProductVariant = typeof productVariants.$inferSelect;
export type NewProductVariant = typeof productVariants.$inferInsert;
```

- [ ] **Step 3: Add order columns** — in `src/server/ordering/schema.ts`, inside `orders` after `vatAmount`:

```ts
  serviceChargeAmount: numeric("service_charge_amount"),
```

and inside `orderItems` after `productId`:

```ts
  variantId: uuid("variant_id"),
  variantNameEn: text("variant_name_en"),
  variantNameAr: text("variant_name_ar"),
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `drizzle/0015_<name>.sql` containing `CREATE TABLE "product_variants"` and the ALTERs for products/orders/order_items (NO tenants changes — those shipped in 0014).

- [ ] **Step 5: Append RLS to the generated migration** — open the new `drizzle/0015_*.sql` and append at the end (exact shape as `drizzle/0007_bitter_mandarin.sql`):

```sql
--> statement-breakpoint
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_variants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY product_variants_isolation ON "product_variants"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
```

- [ ] **Step 6: Migrate both databases**

Run: `npm run db:migrate && npm run db:migrate:test`
Expected: both complete without error.

- [ ] **Step 7: Write the RLS isolation test**

```ts
// src/server/catalog/variants-rls.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { categories, products, productVariants } from "./schema";

async function tenantWithProduct(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "retail" }).returning();
  const cat = await withTenant(t.id, async (tx) => {
    const [c] = await tx.insert(categories).values({ tenantId: t.id, nameEn: "Cat", nameAr: "فئة" }).returning();
    return c;
  });
  const prod = await withTenant(t.id, async (tx) => {
    const [p] = await tx.insert(products).values({ tenantId: t.id, categoryId: cat.id, nameEn: "P", nameAr: "منتج", basePrice: "10" }).returning();
    return p;
  });
  return { t, prod };
}

describe("product_variants RLS", () => {
  it("isolates variants per tenant and fails closed outside withTenant", async () => {
    const a = await tenantWithProduct("vrls-a");
    const b = await tenantWithProduct("vrls-b");
    await withTenant(a.t.id, (tx) =>
      tx.insert(productVariants).values({ tenantId: a.t.id, productId: a.prod.id, nameEn: "500g", nameAr: "٥٠٠ جم", price: "25", stockQuantity: 5 }),
    );
    const mine = await withTenant(a.t.id, (tx) => tx.select().from(productVariants));
    const theirs = await withTenant(b.t.id, (tx) => tx.select().from(productVariants));
    const bare = await db.select().from(productVariants);
    expect(mine.length).toBe(1);
    expect(theirs.length).toBe(0);
    expect(bare.length).toBe(0); // FORCE RLS fails closed without app.tenant_id
  });
});
```

- [ ] **Step 8: Run the test**

Run: `npm run test -- src/server/catalog/variants-rls.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full suite (schema change regression)**

Run: `npm run test`
Expected: PASS — all existing tests unaffected (new columns are nullable/defaulted).

- [ ] **Step 10: Commit**

```bash
git add src/server/catalog/schema.ts src/server/ordering/schema.ts drizzle src/server/catalog/variants-rls.test.ts
git commit -m "feat(schema): product_variants (RLS), retail product cols, order variant/service-charge cols"
```
---

### Task 3: Variant CRUD service + capability gating

**Files:**
- Create: `src/server/catalog/variants.ts`
- Modify: `src/server/catalog/service.ts` (gate modifiers; extend product input types)
- Modify: `src/server/catalog/errors.ts` (InvalidVariantError)
- Modify: `src/server/catalog/index.ts` (barrel)
- Test: `src/server/catalog/variants.test.ts`

**Interfaces:**
- Consumes: `requireCapability`, `VerticalId` from `@/server/verticals`; `getTenantById` from `@/server/tenancy`; `withTenant`; `productVariants`, `ProductVariant` from `./schema` (Task 2).
- Produces: `VariantInput = { id?: string; nameEn: string; nameAr: string; sku?: string | null; price: string; stockQuantity?: number | null; isActive?: boolean; sortOrder?: number }`; `listVariants(tenantId, productId): Promise<ProductVariant[]>`; `upsertVariant(tenantId, productId, input): Promise<ProductVariant>`; `deleteVariant(tenantId, variantId): Promise<void>`; `setProductStock(tenantId, productId, qty: number | null)`; `setVariantStock(tenantId, variantId, qty: number | null)`; extended `CreateProductInput`/`UpdateProductInput` including `brand/sku/trackStock/stockQuantity`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/server/catalog/variants.test.ts
import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createCategory, createProduct, upsertModifierGroup } from "./service";
import { listVariants, upsertVariant, deleteVariant, setVariantStock } from "./variants";
import { CapabilityNotEnabledError } from "@/server/verticals";

async function setup(slug: string, vertical: "restaurant" | "retail") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const cat = await createCategory(t.id, { nameEn: "Cat", nameAr: "فئة" });
  const prod = await createProduct(t.id, { nameEn: "Hinge", nameAr: "مفصلة", basePrice: "50", categoryId: cat.id });
  return { t, prod };
}

describe("variants service", () => {
  it("creates, updates, lists, deletes variants for a retail tenant", async () => {
    const { t, prod } = await setup("var1", "retail");
    const v = await upsertVariant(t.id, prod.id, { nameEn: "35mm", nameAr: "٣٥مم", price: "55", stockQuantity: 10 });
    expect(v.nameEn).toBe("35mm");
    const updated = await upsertVariant(t.id, prod.id, { id: v.id, nameEn: "35mm Soft-Close", nameAr: "٣٥مم", price: "65", stockQuantity: 10 });
    expect(updated.price).toBe("65");
    await setVariantStock(t.id, v.id, 3);
    const list = await listVariants(t.id, prod.id);
    expect(list.length).toBe(1);
    expect(list[0].stockQuantity).toBe(3);
    await deleteVariant(t.id, v.id);
    expect((await listVariants(t.id, prod.id)).length).toBe(0);
  });

  it("rejects variants for a restaurant tenant (capability gate)", async () => {
    const { t, prod } = await setup("var2", "restaurant");
    await expect(upsertVariant(t.id, prod.id, { nameEn: "X", nameAr: "س", price: "10" }))
      .rejects.toThrow(CapabilityNotEnabledError);
  });

  it("rejects modifier groups for a retail tenant (capability gate)", async () => {
    const { t, prod } = await setup("var3", "retail");
    await expect(upsertModifierGroup(t.id, prod.id, { nameEn: "Extras", nameAr: "إضافات", required: false, minSelections: 0, maxSelections: 1 }))
      .rejects.toThrow(CapabilityNotEnabledError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/server/catalog/variants.test.ts`
Expected: FAIL — cannot resolve `./variants`.

- [ ] **Step 3: Implement `variants.ts`**

```ts
// src/server/catalog/variants.ts
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { getTenantById } from "@/server/tenancy";
import { requireCapability, type VerticalId } from "@/server/verticals";
import { productVariants, type ProductVariant } from "./schema";
import { ProductNotFoundError } from "./errors";

export type VariantInput = {
  id?: string;
  nameEn: string;
  nameAr: string;
  sku?: string | null;
  price: string;
  stockQuantity?: number | null;
  isActive?: boolean;
  sortOrder?: number;
};

async function requireTenantCapability(tenantId: string, cap: "variants" | "stockTracking"): Promise<void> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new ProductNotFoundError();
  requireCapability(tenant.vertical as VerticalId, cap);
}

export async function listVariants(tenantId: string, productId: string): Promise<ProductVariant[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(productVariants).where(eq(productVariants.productId, productId)).orderBy(productVariants.sortOrder),
  );
}

export async function upsertVariant(tenantId: string, productId: string, input: VariantInput): Promise<ProductVariant> {
  await requireTenantCapability(tenantId, "variants");
  if (input.id) {
    const [row] = await withTenant(tenantId, (tx) =>
      tx.update(productVariants)
        .set({ nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
        .where(and(eq(productVariants.id, input.id), eq(productVariants.productId, productId)))
        .returning(),
    );
    if (!row) throw new ProductNotFoundError();
    return row;
  }
  const [row] = await withTenant(tenantId, (tx) =>
    tx.insert(productVariants)
      .values({ tenantId, productId, nameEn: input.nameEn, nameAr: input.nameAr, sku: input.sku ?? null, price: input.price, stockQuantity: input.stockQuantity ?? null, isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0 })
      .returning(),
  );
  return row;
}

export async function deleteVariant(tenantId: string, variantId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.delete(productVariants).where(eq(productVariants.id, variantId)),
  );
}

export async function setVariantStock(tenantId: string, variantId: string, qty: number | null): Promise<void> {
  await requireTenantCapability(tenantId, "stockTracking");
  await withTenant(tenantId, (tx) =>
    tx.update(productVariants).set({ stockQuantity: qty }).where(eq(productVariants.id, variantId)),
  );
}
```

Also add `setProductStock` at the end of the same file (simple products without variants; `products` joins the existing schema import at the top: `import { productVariants, products, type ProductVariant } from "./schema";`):

```ts
export async function setProductStock(tenantId: string, productId: string, qty: number | null): Promise<void> {
  await requireTenantCapability(tenantId, "stockTracking");
  await withTenant(tenantId, (tx) =>
    tx.update(products).set({ stockQuantity: qty, trackStock: qty !== null }).where(eq(products.id, productId)),
  );
}
```

Stock semantics note (consistent across publish + ordering): `trackStock && stockQuantity === null` is treated as **0** (shown out of stock, orders blocked) — never as "untracked". Variant `stockQuantity === null` means untracked (always purchasable).

- [ ] **Step 4: Gate modifiers + extend product inputs in `service.ts`**

In `src/server/catalog/service.ts`:
1. Add imports: `import { getTenantById } from "@/server/tenancy";` and `import { requireCapability, type VerticalId } from "@/server/verticals";`
2. At the top of `upsertModifierGroup` (before validation), add:

```ts
  const tenant = await getTenantById(tenantId);
  if (tenant) requireCapability(tenant.vertical as VerticalId, "modifiers");
```

3. Extend the input types (retail fields ride along; undefined keys are no-ops for restaurants):

```ts
export type CreateProductInput = Pick<NewProduct, "nameEn" | "nameAr" | "descriptionEn" | "descriptionAr" | "basePrice" | "imageUrl" | "sortOrder" | "categoryId" | "isFeatured" | "brand" | "sku" | "trackStock" | "stockQuantity">;
```

(`UpdateProductInput` already derives from it via `Partial`.)

- [ ] **Step 5: Update the barrel** — in `src/server/catalog/index.ts` add:

```ts
export { productVariants, type ProductVariant, type NewProductVariant } from "./schema";
export { listVariants, upsertVariant, deleteVariant, setVariantStock, setProductStock, type VariantInput } from "./variants";
```

- [ ] **Step 6: Run tests**

Run: `npm run test -- src/server/catalog/`
Expected: PASS — new tests plus all existing catalog tests (restaurant modifier tests still pass because restaurant tenants have the `modifiers` capability).

- [ ] **Step 7: Commit**

```bash
git add src/server/catalog
git commit -m "feat(catalog): variant CRUD + stock setters, capability-gated modifiers/variants"
```

---

### Task 4: Published catalog exposes variants, brand, and stock state

**Files:**
- Modify: `src/server/catalog/schema.ts` (PublishedMenu type)
- Modify: `src/server/catalog/service.ts` (getPublishedMenu)
- Test: `src/server/catalog/service.test.ts` (extend)

**Interfaces:**
- Consumes: `productVariants` (Task 2), `listVariants` semantics (active only, sortOrder).
- Produces: `PublishedMenu` products gain `brand: string | null`, `inStock: boolean`, `variants: PublishedVariant[]` where `PublishedVariant = { id: string; nameEn: string; nameAr: string; price: number; inStock: boolean }`. Rule: variant `inStock` = `stockQuantity === null || stockQuantity > 0`; product `inStock` = variants exist ? some variant in stock : (`trackStock` ? `(stockQuantity ?? 0) > 0` : `true`).

- [ ] **Step 1: Write the failing test** — append to `src/server/catalog/service.test.ts` (mirror its existing setup helpers; create the tenant with `vertical: "retail"`):

```ts
describe("getPublishedMenu retail fields", () => {
  it("includes brand, variants with prices, and stock state", async () => {
    const [t] = await db.insert(tenants).values({ slug: "pubret", name: "T", country: "EG", vertical: "retail" }).returning();
    await seedDefaultPlans();
    await startTrial(t.id, "pro");
    const cat = await createCategory(t.id, { nameEn: "Hinges", nameAr: "مفصلات" });
    const prod = await createProduct(t.id, { nameEn: "Soft-Close Hinge", nameAr: "مفصلة", basePrice: "50", categoryId: cat.id, brand: "Grimme" });
    await updateProduct(t.id, prod.id, { isPublished: true });
    await upsertVariant(t.id, prod.id, { nameEn: "35mm", nameAr: "٣٥مم", price: "55", stockQuantity: 4 });
    await upsertVariant(t.id, prod.id, { nameEn: "40mm", nameAr: "٤٠مم", price: "60", stockQuantity: 0 });

    const menu = await getPublishedMenu(t.id);
    const p = menu.categories[0].products[0];
    expect(p.brand).toBe("Grimme");
    expect(p.variants.map((v) => [v.nameEn, v.price, v.inStock])).toEqual([["35mm", 55, true], ["40mm", 60, false]]);
    expect(p.inStock).toBe(true); // at least one variant in stock

    // out-of-stock tracked simple product
    const prod2 = await createProduct(t.id, { nameEn: "Worktop", nameAr: "سطح", basePrice: "900", categoryId: cat.id, trackStock: true, stockQuantity: 0 });
    await updateProduct(t.id, prod2.id, { isPublished: true });
    const menu2 = await getPublishedMenu(t.id);
    const p2 = menu2.categories[0].products.find((x) => x.nameEn === "Worktop")!;
    expect(p2.inStock).toBe(false);
    expect(p2.variants).toEqual([]);
  });
});
```

(Add the needed imports at the top of the test file: `upsertVariant` from `./variants`.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/server/catalog/service.test.ts`
Expected: FAIL — `brand`/`variants`/`inStock` missing from PublishedMenu products.

- [ ] **Step 3: Extend the `PublishedMenu` type** in `src/server/catalog/schema.ts` — add to the product entry, after `imageUrl`:

```ts
      brand: string | null;
      inStock: boolean;
      variants: Array<{ id: string; nameEn: string; nameAr: string; price: number; inStock: boolean }>;
```

- [ ] **Step 4: Implement in `getPublishedMenu`** (`src/server/catalog/service.ts`):
1. When selecting product rows in the `branchId` branch, also select `brand: products.brand, trackStock: products.trackStock, stockQuantity: products.stockQuantity` and carry them through the mapping. The non-branch path (`tx.select().from(products)`) already returns them.
2. After loading modifier groups/options, load variants:

```ts
    const variantRows = productIds.length > 0
      ? await tx.select().from(productVariants)
          .where(and(inArray(productVariants.productId, productIds), eq(productVariants.isActive, true)))
          .orderBy(productVariants.sortOrder)
      : [];
    const variantsByProduct = groupBy(variantRows, (v) => v.productId);
```

3. In the product mapping inside `prodsByCat`, add:

```ts
        brand: p.brand,
        variants: (variantsByProduct[p.id] ?? []).map((v) => ({
          id: v.id, nameEn: v.nameEn, nameAr: v.nameAr,
          price: Number(v.price),
          inStock: v.stockQuantity === null || v.stockQuantity > 0,
        })),
        inStock: (variantsByProduct[p.id] ?? []).length > 0
          ? (variantsByProduct[p.id] ?? []).some((v) => v.stockQuantity === null || v.stockQuantity > 0)
          : p.trackStock
            ? (p.stockQuantity ?? 0) > 0
            : true,
```

(Import `productVariants` in the file's schema import list. `Product` rows from the plain path already carry `trackStock`/`stockQuantity`; make sure the branch-override mapping copies them onto `prodRows`.)

- [ ] **Step 5: Run tests**

Run: `npm run test -- src/server/catalog/`
Expected: PASS, including all pre-existing menu tests (restaurant products: `variants: []`, `inStock: true` — no visible change to the menu template, which ignores the new fields).

- [ ] **Step 6: Commit**

```bash
git add src/server/catalog
git commit -m "feat(catalog): published menu exposes brand, variants, and stock state"
```

---

### Task 5: `computeOrderTotals` + checkout pricing settings + placeOrder refactor

**Files:**
- Create: `src/lib/order-totals.ts`
- Test: `src/lib/order-totals.test.ts`
- Modify: `src/server/tenancy/settings.ts` (+ `TenantSettingsData`, `getCheckoutPricing`, setters)
- Modify: `src/server/tenancy/index.ts` (barrel)
- Modify: `src/server/ordering/service.ts` (use computeOrderTotals; write serviceChargeAmount)
- Test: extend `src/server/ordering/place-order.test.ts`

**Interfaces:**
- Consumes: `getCapabilities` from `@/server/verticals` (registry import is pure — no import cycle); `tenants.vertical` (Task 2).
- Produces:

```ts
export type CheckoutPricing = { vatEnabled: boolean; vatRate: number; pricesIncludeVat: boolean; serviceChargeRate: number };
export type OrderTotals = { subtotal: number; serviceChargeAmount: number; vatRate: number; vatAmount: number; vatIncludedInPrices: boolean; deliveryFee: number; total: number };
export function computeOrderTotals(pricing: CheckoutPricing, subtotal: number, deliveryFee: number): OrderTotals;
// server-side:
export async function getCheckoutPricing(tenantId: string): Promise<CheckoutPricing>;
export async function setVatEnabled(tenantId: string, enabled: boolean): Promise<void>;
export async function setPricesIncludeVat(tenantId: string, inclusive: boolean): Promise<void>;
export async function setServiceChargeRate(tenantId: string, rate: number | null): Promise<void>; // validates 0–100
```

**Spec reconciliation (important):** the spec says "adjustments default off"; in reality VAT is *already always applied* (`getVatRate` + `vatAmount` on orders). The governing requirement is *zero behavior change*, so defaults are: `vatEnabled: true`, `pricesIncludeVat: false`, `serviceChargeRate: 0`. One deliberate improvement: `vatAmount` is now rounded to 2dp *before* summing into `total`, so displayed lines always sum exactly to the total.

- [ ] **Step 1: Write the failing unit tests**

```ts
// src/lib/order-totals.test.ts
import { describe, it, expect } from "vitest";
import { computeOrderTotals, type CheckoutPricing } from "./order-totals";

const base: CheckoutPricing = { vatEnabled: true, vatRate: 14, pricesIncludeVat: false, serviceChargeRate: 0 };

describe("computeOrderTotals", () => {
  it("matches today's computation with default settings (exclusive VAT, no service charge)", () => {
    const t = computeOrderTotals(base, 200, 25);
    expect(t).toEqual({ subtotal: 200, serviceChargeAmount: 0, vatRate: 14, vatAmount: 28, vatIncludedInPrices: false, deliveryFee: 25, total: 253 });
  });

  it("applies service charge before VAT (restaurant)", () => {
    const t = computeOrderTotals({ ...base, serviceChargeRate: 12 }, 100, 0);
    expect(t.serviceChargeAmount).toBe(12);
    expect(t.vatAmount).toBe(15.68); // 14% of 112
    expect(t.total).toBe(127.68);
  });

  it("inclusive VAT extracts an informational amount without changing the total", () => {
    const t = computeOrderTotals({ ...base, pricesIncludeVat: true }, 114, 10);
    expect(t.vatAmount).toBe(14); // 114 * 14/114
    expect(t.vatIncludedInPrices).toBe(true);
    expect(t.total).toBe(124); // subtotal + fee, VAT already inside
  });

  it("vatEnabled=false charges no VAT", () => {
    const t = computeOrderTotals({ ...base, vatEnabled: false }, 100, 0);
    expect(t.vatAmount).toBe(0);
    expect(t.vatRate).toBe(0);
    expect(t.total).toBe(100);
  });

  it("rounds each line to 2dp and lines sum to total", () => {
    const t = computeOrderTotals(base, 33.335, 0);
    expect(t.subtotal + t.serviceChargeAmount + t.vatAmount).toBeCloseTo(t.total, 10);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/lib/order-totals.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure function**

```ts
// src/lib/order-totals.ts
// The ONLY place order money math lives. Server (placeOrder) computes and
// persists these numbers; checkout renders the same breakdown client-side.

export type CheckoutPricing = {
  vatEnabled: boolean;
  vatRate: number;           // percent, e.g. 14
  pricesIncludeVat: boolean; // true: VAT shown as informational, already in prices
  serviceChargeRate: number; // percent; 0 = off (capability-gated upstream)
};

export type OrderTotals = {
  subtotal: number;
  serviceChargeAmount: number;
  vatRate: number;
  vatAmount: number;
  vatIncludedInPrices: boolean;
  deliveryFee: number;
  total: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeOrderTotals(pricing: CheckoutPricing, subtotal: number, deliveryFee: number): OrderTotals {
  const sub = round2(subtotal);
  const fee = round2(deliveryFee);
  const serviceChargeAmount = round2(sub * (pricing.serviceChargeRate / 100));
  const taxable = round2(sub + serviceChargeAmount);

  if (!pricing.vatEnabled) {
    return { subtotal: sub, serviceChargeAmount, vatRate: 0, vatAmount: 0, vatIncludedInPrices: false, deliveryFee: fee, total: round2(taxable + fee) };
  }
  if (pricing.pricesIncludeVat) {
    const vatAmount = round2(taxable * (pricing.vatRate / (100 + pricing.vatRate)));
    return { subtotal: sub, serviceChargeAmount, vatRate: pricing.vatRate, vatAmount, vatIncludedInPrices: true, deliveryFee: fee, total: round2(taxable + fee) };
  }
  const vatAmount = round2(taxable * (pricing.vatRate / 100));
  return { subtotal: sub, serviceChargeAmount, vatRate: pricing.vatRate, vatAmount, vatIncludedInPrices: false, deliveryFee: fee, total: round2(taxable + vatAmount + fee) };
}
```

- [ ] **Step 4: Run unit tests**

Run: `npm run test -- src/lib/order-totals.test.ts`
Expected: PASS.

- [ ] **Step 5: Settings + `getCheckoutPricing`** — in `src/server/tenancy/settings.ts`:
1. Extend the bag type:

```ts
export type TenantSettingsData = {
  vatRate?: number;
  vatEnabled?: boolean;
  pricesIncludeVat?: boolean;
  serviceChargeRate?: number;
  whatsappNumber?: string;
  upgradeRequest?: { planKey: string; requestedAt: string };
};
```

2. Add (imports: `import { getCapabilities } from "@/server/verticals/registry";` and `import type { VerticalId } from "@/server/verticals/types";` — import from the concrete files, not the barrel, to keep this file cycle-free, plus `import type { CheckoutPricing } from "@/lib/order-totals";`):

```ts
export async function getCheckoutPricing(tenantId: string): Promise<CheckoutPricing> {
  const settings = await getTenantSettings(tenantId);
  const [t] = await db.select({ country: tenants.country, vertical: tenants.vertical }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const caps = getCapabilities((t?.vertical ?? "restaurant") as VerticalId);
  return {
    vatEnabled: settings.vatEnabled ?? true,
    vatRate: typeof settings.vatRate === "number" ? settings.vatRate : defaultVatRate(t?.country ?? "EG"),
    pricesIncludeVat: settings.pricesIncludeVat ?? false,
    serviceChargeRate: caps.serviceCharge ? (settings.serviceChargeRate ?? 0) : 0,
  };
}

export async function setVatEnabled(tenantId: string, enabled: boolean): Promise<void> {
  await patchTenantSettings(tenantId, { vatEnabled: enabled });
}

export async function setPricesIncludeVat(tenantId: string, inclusive: boolean): Promise<void> {
  await patchTenantSettings(tenantId, { pricesIncludeVat: inclusive });
}

export async function setServiceChargeRate(tenantId: string, rate: number | null): Promise<void> {
  if (rate !== null && (Number.isNaN(rate) || rate < 0 || rate > 100)) throw new Error(`Invalid service charge rate: ${rate}`);
  await patchTenantSettings(tenantId, { serviceChargeRate: rate ?? undefined });
}
```

3. Export the new functions from `src/server/tenancy/index.ts` (add `getCheckoutPricing, setVatEnabled, setPricesIncludeVat, setServiceChargeRate` to the existing settings export line).

- [ ] **Step 6: Refactor `placeOrder`** — in `src/server/ordering/service.ts`:
1. Replace the import of `getVatRate` with `getCheckoutPricing` and add `import { computeOrderTotals } from "@/lib/order-totals";`
2. Replace `const vatRate = await getVatRate(tenantId);` with `const pricing = await getCheckoutPricing(tenantId);`
3. Replace step "// 4. Totals" (`const vatAmount = ...; const total = ...;`) with:

```ts
    // 4. Totals — single source of money math (src/lib/order-totals.ts)
    const totals = computeOrderTotals(pricing, subtotal, deliveryFee);
```

4. In the `orders` insert, replace the totals fields with:

```ts
      subtotal: money(totals.subtotal),
      vatRateSnapshot: money(totals.vatRate),
      vatAmount: money(totals.vatAmount),
      serviceChargeAmount: totals.serviceChargeAmount > 0 ? money(totals.serviceChargeAmount) : null,
      deliveryFee: money(totals.deliveryFee),
      total: money(totals.total),
```

- [ ] **Step 7: Extend integration tests** — append to `src/server/ordering/place-order.test.ts`:

```ts
  it("keeps default totals identical to the legacy computation (VAT exclusive, no service charge)", async () => {
    const { t, branch, pizza } = await setup("po-tot1");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.subtotal).toBe("100.00");
    expect(order.vatAmount).toBe("14.00");     // EG default 14%
    expect(order.serviceChargeAmount).toBeNull();
    expect(order.total).toBe("114.00");
  });

  it("applies a configured service charge for a restaurant tenant", async () => {
    const { t, branch, pizza } = await setup("po-tot2");
    const { setServiceChargeRate } = await import("@/server/tenancy");
    await setServiceChargeRate(t.id, 10);
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: pizza.id, quantity: 1, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.serviceChargeAmount).toBe("10.00");
    expect(order.vatAmount).toBe("15.40"); // 14% of 110
    expect(order.total).toBe("125.40");
  });
```

- [ ] **Step 8: Run the ordering + tenancy suites**

Run: `npm run test -- src/server/ordering src/server/tenancy src/lib/order-totals.test.ts`
Expected: PASS — including every pre-existing place-order test (defaults preserve behavior).

- [ ] **Step 9: Commit**

```bash
git add src/lib/order-totals.ts src/lib/order-totals.test.ts src/server/tenancy src/server/ordering
git commit -m "feat(ordering): computeOrderTotals single money source + vertical-aware checkout pricing settings"
```

---

### Task 6: Variant order lines + atomic stock decrement + restock on cancel

**Files:**
- Modify: `src/server/ordering/service.ts`
- Modify: `src/server/ordering/errors.ts` (OutOfStockError)
- Modify: `src/server/catalog/errors.ts` (InvalidVariantError)
- Modify: `src/app/api/orders/route.ts` (variantId allowlist)
- Test: extend `src/server/ordering/place-order.test.ts`

**Interfaces:**
- Consumes: `productVariants` (Task 2), `getCapabilities` (Task 1), `upsertVariant` (Task 3, in tests).
- Produces: `PlaceOrderLine = { productId: string; variantId?: string; quantity: number; selectedOptionIds: string[] }`; `OutOfStockError` (code `out_of_stock`, carries product name en/ar); `InvalidVariantError` (code `invalid_variant`); restock behavior on `cancelled`/`rejected` transitions.

- [ ] **Step 1: Write the failing tests** — append to `src/server/ordering/place-order.test.ts` (add a retail setup helper next to the existing `setup`):

```ts
async function setupRetail(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "R", country: "EG", vertical: "retail" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const branch = await createBranch(t.id, { name: "Main" });
  await updateBranchOrdering(t.id, branch.id, { acceptingOrders: true, openingHours: [] });
  const cat = await createCategory(t.id, { nameEn: "Hinges", nameAr: "مفصلات" });
  const hinge = await createProduct(t.id, { nameEn: "Hinge", nameAr: "مفصلة", basePrice: "50", categoryId: cat.id });
  await updateProduct(t.id, hinge.id, { isPublished: true });
  const { upsertVariant } = await import("@/server/catalog/variants");
  const v35 = await upsertVariant(t.id, hinge.id, { nameEn: "35mm", nameAr: "٣٥مم", price: "55", stockQuantity: 2 });
  return { t, branch, hinge, v35 };
}

describe("placeOrder retail variants + stock", () => {
  it("prices a variant line from the DB and snapshots the variant name", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv1");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    });
    const { getOrder } = await import("./service");
    const order = await getOrder(t.id, res.orderId);
    expect(order.subtotal).toBe("110.00"); // 2 × 55, NOT basePrice 50
    expect(order.items[0].variantNameEn).toBe("35mm");
    expect(order.items[0].variantId).toBe(v35.id);
  });

  it("decrements stock and rejects when insufficient", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv2");
    const { OutOfStockError } = await import("./errors");
    await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    }); // stock now 0
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "B", customerPhone: "2",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(OutOfStockError);
  });

  it("exactly one of two concurrent orders for the last unit succeeds", async () => {
    const { t, branch, hinge } = await setupRetail("rv3");
    const { upsertVariant } = await import("@/server/catalog/variants");
    const last = await upsertVariant(t.id, hinge.id, { nameEn: "40mm", nameAr: "٤٠مم", price: "60", stockQuantity: 1 });
    const attempt = (name: string) => placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: name, customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: last.id, quantity: 1, selectedOptionIds: [] }],
    });
    const results = await Promise.allSettled([attempt("A"), attempt("B")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
  });

  it("rejects an unknown or inactive variant", async () => {
    const { t, branch, hinge } = await setupRetail("rv4");
    const { InvalidVariantError } = await import("@/server/catalog/errors");
    await expect(placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: "00000000-0000-0000-0000-000000000000", quantity: 1, selectedOptionIds: [] }],
    })).rejects.toThrow(InvalidVariantError);
  });

  it("restocks on customer cancel", async () => {
    const { t, branch, hinge, v35 } = await setupRetail("rv5");
    const res = await placeOrder(t.id, {
      branchId: branch.id, fulfillmentType: "pickup", customerName: "A", customerPhone: "1",
      lines: [{ productId: hinge.id, variantId: v35.id, quantity: 2, selectedOptionIds: [] }],
    });
    const { cancelOrderByToken } = await import("./service");
    await cancelOrderByToken(t.id, res.statusToken);
    const { listVariants } = await import("@/server/catalog/variants");
    const [v] = await listVariants(t.id, hinge.id);
    expect(v.stockQuantity).toBe(2); // back to full
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/server/ordering/place-order.test.ts`
Expected: new tests FAIL (`variantId` not accepted / errors missing).

- [ ] **Step 3: Add the typed errors**

In `src/server/ordering/errors.ts` append:

```ts
export class OutOfStockError extends DomainError {
  readonly code = "out_of_stock";
  constructor(readonly productNameEn: string, readonly productNameAr: string) {
    super(`Out of stock: ${productNameEn}`);
    this.name = "OutOfStockError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? `"${this.productNameAr}" غير متوفر بالكمية المطلوبة` : `"${this.productNameEn}" doesn't have enough stock`;
  }
}
```

In `src/server/catalog/errors.ts` append:

```ts
export class InvalidVariantError extends DomainError {
  readonly code = "invalid_variant";
  constructor() {
    super("Invalid product variant");
    this.name = "InvalidVariantError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar" ? "خيار المنتج غير متاح" : "That product option is unavailable";
  }
}
```

- [ ] **Step 4: Implement in `placeOrder`** (`src/server/ordering/service.ts`):
1. Type + imports:

```ts
export type PlaceOrderLine = { productId: string; variantId?: string; quantity: number; selectedOptionIds: string[] };
```

```ts
import { products, modifierGroups, modifierOptions, branchProductAvailability, productVariants } from "@/server/catalog/schema";
import { InvalidVariantError } from "@/server/catalog/errors";
import { getCapabilities, type VerticalId } from "@/server/verticals";
import { OutOfStockError } from "./errors"; // add to existing errors import
import { gte, isNull, or } from "drizzle-orm"; // add to existing drizzle import
```

2. After `const tenant = await getTenantById(tenantId);` add:

```ts
  const caps = getCapabilities(tenant.vertical as VerticalId);
```

3. Extend `itemsToInsert`'s element type with `variantId: string | null; variantNameEn: string | null; variantNameAr: string | null;`.
4. Inside the per-line loop, after the product fetch + branch-availability check, branch on `line.variantId`:

```ts
      let unit: number;
      let selected: typeof opts = [];
      let variantId: string | null = null;
      let variantNameEn: string | null = null;
      let variantNameAr: string | null = null;

      if (line.variantId) {
        if (line.selectedOptionIds.length > 0) throw new OrderValidationError("modifiers not allowed on variant lines");
        const [variant] = await tx.select().from(productVariants)
          .where(and(eq(productVariants.id, line.variantId), eq(productVariants.productId, product.id), eq(productVariants.isActive, true)))
          .limit(1);
        if (!variant) throw new InvalidVariantError();
        unit = Number(variant.price);
        variantId = variant.id;
        variantNameEn = variant.nameEn;
        variantNameAr = variant.nameAr;
      } else {
        // existing modifier flow (groups/opts fetch, dedupe, min/max checks) unchanged;
        // it computes `selected` and `unit = Number(effectiveBase) + modifiersTotal`.
      }
```

Keep the existing modifier code inside the `else` (move it, don't rewrite it). The snapshot mapping and `itemsToInsert.push` gain the three variant fields; for variant lines `unitBasePrice` is `String(unit)` and `selectedModifiers` is `[]`.
5. Stock decrement — still inside the per-line loop, immediately after the unit price is known:

```ts
      if (caps.stockTracking) {
        if (variantId) {
          // Guarded UPDATE: under READ COMMITTED the second concurrent writer
          // re-evaluates the WHERE after the first commits, so exactly one
          // order gets the last unit. NULL stock (untracked) stays NULL.
          const hit = await tx.update(productVariants)
            .set({ stockQuantity: sql`${productVariants.stockQuantity} - ${line.quantity}` })
            .where(and(
              eq(productVariants.id, variantId),
              or(isNull(productVariants.stockQuantity), gte(productVariants.stockQuantity, line.quantity)),
            ))
            .returning({ id: productVariants.id });
          if (hit.length === 0) throw new OutOfStockError(product.nameEn, product.nameAr);
        } else if (product.trackStock) {
          const hit = await tx.update(products)
            .set({ stockQuantity: sql`${products.stockQuantity} - ${line.quantity}` })
            .where(and(eq(products.id, product.id), gte(products.stockQuantity, line.quantity)))
            .returning({ id: products.id });
          if (hit.length === 0) throw new OutOfStockError(product.nameEn, product.nameAr);
        }
      }
```

- [ ] **Step 5: Restock on cancel/reject** — add a helper in `src/server/ordering/service.ts`:

```ts
/** Returns order-item quantities to stock. No-op for verticals without stockTracking.
 * NULL stock (untracked) is left NULL; `sql`x + n`` on NULL stays NULL, so no guard needed. */
async function restockOrderItems(tx: Parameters<Parameters<typeof withTenant>[1]>[0], orderId: string, caps: { stockTracking: boolean }): Promise<void> {
  if (!caps.stockTracking) return;
  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  for (const item of items) {
    if (item.variantId) {
      await tx.update(productVariants)
        .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${item.quantity}` })
        .where(eq(productVariants.id, item.variantId));
    } else {
      await tx.update(products)
        .set({ stockQuantity: sql`${products.stockQuantity} + ${item.quantity}` })
        .where(and(eq(products.id, item.productId), eq(products.trackStock, true)));
    }
  }
}
```

Call it in **both** cancel paths, after the guarded status UPDATE succeeded (so restock happens exactly once):
- `cancelOrderByToken`: load tenant capabilities before `withTenant` (`const tenant = await getTenantById(tenantId); const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);`), then after the `if (!updated) throw ...` line: `await restockOrderItems(tx, order.id, caps);`
- `transitionStatus`: same capability load; after the guarded update succeeds and only when `to === "cancelled" || to === "rejected"`: `await restockOrderItems(tx, orderId, caps);`

- [ ] **Step 6: Accept `variantId` at the API boundary** — in `src/app/api/orders/route.ts`, in the line mapping add:

```ts
            variantId: typeof line.variantId === "string" ? line.variantId : undefined,
```

- [ ] **Step 7: Run the ordering suite**

Run: `npm run test -- src/server/ordering`
Expected: PASS — all new retail tests and all pre-existing restaurant tests (restaurant caps have `stockTracking: false`, so no stock paths execute).

- [ ] **Step 8: Commit**

```bash
git add src/server/ordering src/server/catalog/errors.ts src/app/api/orders/route.ts
git commit -m "feat(ordering): variant lines with DB pricing, atomic stock decrement, restock on cancel"
```
---

### Task 7: Variant-aware cart

**Files:**
- Modify: `src/app/_components/cart.ts`
- Test: `src/app/_components/cart.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new (pure browser lib).
- Produces: `CartLine` gains `variantId?: string; variantNameEn?: string;` — merge identity becomes product + variant + option set. Old persisted carts (no variant fields) keep working: `undefined` variant compares equal to `undefined`.

- [ ] **Step 1: Write the failing tests** — append to `src/app/_components/cart.test.ts` (mirror its existing style):

```ts
describe("variant-aware merge", () => {
  const line = (productId: string, variantId?: string): CartLine => ({
    productId, variantId, variantNameEn: variantId ? "35mm" : undefined,
    nameEn: "Hinge", nameAr: "مفصلة", quantity: 1, unitPrice: 55,
    selectedOptionIds: [], modifierSummaryEn: "",
  });

  it("merges same product + same variant", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", line("p1", "v1"));
    const c2 = mergeLine(c1, "b1", line("p1", "v1"));
    expect(c2.lines.length).toBe(1);
    expect(c2.lines[0].quantity).toBe(2);
  });

  it("keeps different variants of the same product as separate lines", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", line("p1", "v1"));
    const c2 = mergeLine(c1, "b1", line("p1", "v2"));
    expect(c2.lines.length).toBe(2);
  });

  it("keeps a variant line separate from a no-variant line (legacy cart compat)", () => {
    const c1 = mergeLine({ branchId: null, lines: [] }, "b1", line("p1"));
    const c2 = mergeLine(c1, "b1", line("p1", "v1"));
    expect(c2.lines.length).toBe(2);
  });
});
```

(Import `mergeLine`, `type CartLine` — already exported.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- src/app/_components/cart.test.ts`
Expected: FAIL — type error on `variantId` / merge collapses different variants.

- [ ] **Step 3: Implement** — in `src/app/_components/cart.ts`:
1. `CartLine` gains, after `productId`:

```ts
  variantId?: string;
  variantNameEn?: string;
```

2. In `mergeLine`, the `findIndex` predicate becomes:

```ts
  const i = cart.lines.findIndex(
    (l) =>
      l.productId === line.productId &&
      (l.variantId ?? null) === (line.variantId ?? null) &&
      sameOptions(l.selectedOptionIds, line.selectedOptionIds),
  );
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/app/_components/cart.test.ts`
Expected: PASS (all pre-existing merge tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/app/_components/cart.ts src/app/_components/cart.test.ts
git commit -m "feat(cart): variant-aware line identity"
```

---

### Task 8 (REVISED): Registry terms drive the storefront empty states

The merged scaffold already extracted the restaurant storefront (`RestaurantStorefront` over `StorefrontShell`) and dispatches per vertical in `page.tsx` via `selectStorefrontTemplate`. The shell's empty-catalog copy already flows from `VERTICAL_STOREFRONT_COPY`, which Task 1 turned into a descriptor derivation. What remains: the two hardcoded pre-template empty states in `page.tsx`.

**Files:**
- Modify: `src/app/page.tsx`
- Verify: `npm run test:e2e -- tests/e2e/menu.spec.ts` unchanged and green

**Interfaces:**
- Consumes: `getVerticalTerms`, `selectStorefrontTemplate`, `VerticalId` from `@/server/verticals` (Task 1).

- [ ] **Step 1: Terms-driven empty states** — in `src/app/page.tsx`'s storefront branch:
1. The unknown-slug branch has no tenant row, so it keeps a neutral title — change `<EmptyState title="Store not found" />` to `<EmptyState title="Not found" />`.
2. The not-servable branch knows the tenant; replace the hardcoded `description="This store is getting ready. Check back soon!"` with:

```tsx
    const terms = getVerticalTerms(selectStorefrontTemplate(tenant.vertical as VerticalId));
    // ...
    <EmptyState title={tenant.name} description={terms.gettingReadyBody.en} />
```

(`selectStorefrontTemplate` doubles as the safe VerticalId normalizer — reuse it rather than casting blindly.) Import both from `@/server/verticals`.

- [ ] **Step 2: Typecheck + unit suite**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS.

- [ ] **Step 3: Regression-verify the storefront e2e (unmodified spec)**

Run: `npm run test:e2e -- tests/e2e/menu.spec.ts`
Expected: PASS without touching the spec. (Requires the dev DB seeded with `roma`: `npm run db:seed` if not.)

- [ ] **Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(storefront): vertical terms drive pre-template empty states"
```

---

### Task 9 (REVISED): Shop catalog UI inside the merged per-vertical templates

**Files:**
- Create: `src/app/_components/storefront/templates/shop/ShopBrowser.tsx`
- Create: `src/app/_components/storefront/templates/shop/ShopProductCard.tsx`
- Create: `src/app/_components/storefront/templates/shop/RetailProductSheet.tsx`
- Create: `src/app/_components/storefront/templates/shop/shop-search.ts` + test `shop-search.test.ts`
- Modify: `src/app/_components/storefront/templates/StorefrontShell.tsx` (optional catalog slot)
- Modify: `src/app/_components/storefront/templates/RetailStorefront.tsx`, `PharmacyStorefront.tsx`, `TimberStorefront.tsx` (pass the shop catalog into the slot)

**Interfaces:**
- Consumes: `PublishedMenu` with `brand/inStock/variants` (Task 4); cart with variants (Task 7); the merged `StorefrontShell` + `StorefrontTemplateProps`; shared components `CartBar`, `CartDrawer`, `BranchPickSheet`, `SectionHeader`; `MenuProduct` type from `@/app/_components/storefront/ProductCard`.
- Produces: `filterCatalog(categories, query)` pure search helper; `StorefrontShell` gains `catalog?: React.ReactNode` — when undefined it renders its existing `StorefrontMenu` block unchanged, so the restaurant template is untouched; the three shop-vertical wrappers pass `<ShopBrowser …/>`.
- Routing: `page.tsx` already dispatches to the wrappers via `selectStorefrontTemplate` — no dispatch work here.

Design language: reuse the existing premium tokens (`sf-img`, `card-lift`, `eyebrow`, `font-display` — see `src/app/globals.css` and existing storefront components). Retail DNA per the spec: search-first, category-sectioned dense grid, brand eyebrow, stock badges, variant picker. Out-of-stock items stay visible but unpurchasable.

- [ ] **Step 1: Pure search helper + failing test**

```ts
// src/app/_components/storefront/templates/shop/shop-search.ts
import type { PublishedMenu } from "@/server/catalog/schema";

type Categories = PublishedMenu["categories"];

/** Case-insensitive filter over name (en/ar) and brand; drops empty categories. */
export function filterCatalog(categories: Categories, query: string): Categories {
  const q = query.trim().toLowerCase();
  if (!q) return categories;
  return categories
    .map((c) => ({
      ...c,
      products: c.products.filter((p) =>
        [p.nameEn, p.nameAr, p.brand ?? ""].some((s) => s.toLowerCase().includes(q)),
      ),
    }))
    .filter((c) => c.products.length > 0);
}
```

```ts
// src/app/_components/storefront/templates/shop/shop-search.test.ts
import { describe, it, expect } from "vitest";
import { filterCatalog } from "./shop-search";

const cats = [
  { id: "c1", nameEn: "Hinges", nameAr: "مفصلات", imageUrl: null, products: [
    { id: "p1", nameEn: "Soft-Close Hinge", nameAr: "مفصلة", brand: "Grimme" },
    { id: "p2", nameEn: "Standard Hinge", nameAr: "مفصلة عادية", brand: "Egger" },
  ]},
  { id: "c2", nameEn: "Worktops", nameAr: "أسطح", imageUrl: null, products: [
    { id: "p3", nameEn: "Oak Worktop", nameAr: "سطح بلوط", brand: "Egger" },
  ]},
] as never; // structural subset of PublishedMenu["categories"] for the test

describe("filterCatalog", () => {
  it("returns everything for an empty query", () => {
    expect(filterCatalog(cats, "  ").length).toBe(2);
  });
  it("matches by name and drops empty categories", () => {
    const r = filterCatalog(cats, "soft-close");
    expect(r.length).toBe(1);
    expect(r[0].products.map((p) => p.id)).toEqual(["p1"]);
  });
  it("matches by brand across categories", () => {
    const r = filterCatalog(cats, "egger");
    expect(r.flatMap((c) => c.products.map((p) => p.id))).toEqual(["p2", "p3"]);
  });
  it("matches Arabic names", () => {
    expect(filterCatalog(cats, "بلوط")[0].products[0].id).toBe("p3");
  });
});
```

Run: `npm run test -- src/app/_components/storefront/templates/shop/shop-search.test.ts` → FAIL (module missing) → create the helper → PASS.

- [ ] **Step 2: `ShopProductCard`**

```tsx
// src/app/_components/storefront/templates/shop/ShopProductCard.tsx
"use client";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";

/** Dense retail card: brand eyebrow, image, name, price (or "From X" with variants), stock state. */
export function ShopProductCard({
  product, interactive, onOpen, currency,
}: {
  product: MenuProduct;
  interactive: boolean;
  onOpen: () => void;
  currency: string;
}) {
  const inStock = product.inStock;
  const prices = product.variants.length > 0 ? product.variants.map((v) => v.price) : [product.effectivePrice];
  const min = Math.min(...prices);
  const hasRange = product.variants.length > 1 && new Set(prices).size > 1;

  return (
    <button
      type="button"
      onClick={interactive && inStock ? onOpen : undefined}
      disabled={!interactive || !inStock}
      aria-label={product.nameEn}
      className="card-lift group relative flex flex-col overflow-hidden rounded-2xl bg-card text-left"
    >
      <div className="relative aspect-square w-full">
        {product.imageUrl
          ? <img src={product.imageUrl} alt="" loading="lazy" className={`sf-img h-full w-full ${!inStock ? "opacity-40 grayscale" : ""}`} />
          : <div className="sf-img h-full w-full" />}
        {!inStock && (
          <span className="absolute left-2 top-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            Out of stock
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col p-3">
        {product.brand && <span className="eyebrow text-[10px] text-muted-foreground">{product.brand}</span>}
        <h3 className="font-sans text-sm font-semibold leading-tight text-ink">{product.nameEn}</h3>
        <span dir="rtl" className="text-xs text-muted-foreground">{product.nameAr}</span>
        <div className="mt-auto flex items-center justify-between pt-2.5">
          <span className="font-display font-bold text-ink">
            {hasRange ? `From ${formatMoney(min, currency)}` : formatMoney(min, currency)}
          </span>
          {interactive && inStock && (
            <span className="grid size-8 place-items-center rounded-full bg-primary text-lg leading-none text-primary-foreground shadow-sm">+</span>
          )}
        </div>
      </div>
    </button>
  );
}
```

(Uses `eslint-disable` comment for the `img` element like `ProductCard.tsx` does — add `{/* eslint-disable-next-line @next/next/no-img-element */}` above the `<img>`.)

- [ ] **Step 3: `RetailProductSheet`** — variant picker instead of modifier groups:

```tsx
// src/app/_components/storefront/templates/shop/RetailProductSheet.tsx
"use client";
import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import type { MenuProduct } from "@/app/_components/storefront/ProductCard";

export function RetailProductSheet({
  product, open, onOpenChange, onAdd, currency,
}: {
  product: MenuProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (product: MenuProduct, variantId: string | null, quantity: number) => void;
  currency: string;
}) {
  const [variantId, setVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  useEffect(() => {
    if (product) {
      const first = product.variants.find((v) => v.inStock);
      setVariantId(first?.id ?? null);
      setQuantity(1);
    }
  }, [product]);

  if (!product) return null;

  const selected = product.variants.find((v) => v.id === variantId) ?? null;
  const needsVariant = product.variants.length > 0;
  const unitPrice = selected ? selected.price : product.effectivePrice;
  const canAdd = !needsVariant || selected !== null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-0">
        {product.imageUrl && (
          <div className="relative mb-4 aspect-[16/10] w-full flex-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={product.imageUrl} alt={product.nameEn} loading="lazy" width={800} height={500} className="sf-img h-full w-full" />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SheetHeader>
            {product.brand && <span className="eyebrow text-muted-foreground">{product.brand}</span>}
            <SheetTitle className="text-xl sm:text-2xl">{product.nameEn}</SheetTitle>
            {product.descriptionEn && <SheetDescription>{product.descriptionEn}</SheetDescription>}
          </SheetHeader>

          {needsVariant && (
            <div className="mt-5">
              <span className="eyebrow text-ink">Options</span>
              <div className="mt-2 flex flex-col gap-2">
                {product.variants.map((v) => {
                  const isSelected = variantId === v.id;
                  return (
                    <label
                      key={v.id}
                      className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm transition-colors ${
                        !v.inStock ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                      } ${isSelected ? "border-primary bg-accent/60" : "border-border bg-card hover:border-primary/40"}`}
                    >
                      <span className="flex items-center gap-2.5">
                        <input
                          type="radio"
                          name={`${product.id}-variant`}
                          checked={isSelected}
                          disabled={!v.inStock}
                          onChange={() => setVariantId(v.id)}
                          className="accent-primary"
                        />
                        <span className={isSelected ? "font-medium text-ink" : "text-ink"}>{v.nameEn}</span>
                      </span>
                      <span className={isSelected ? "font-medium text-primary" : "text-muted-foreground"}>
                        {v.inStock ? formatMoney(v.price, currency) : "Out of stock"}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="-mx-6 -mb-6 mt-5 flex flex-none items-center gap-3 border-t border-border bg-card px-6 py-4">
          <div className="inline-flex items-center gap-4 rounded-full border border-border px-4 py-2">
            <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Decrease quantity">−</button>
            <span className="w-4 text-center font-display font-semibold text-ink">{quantity}</span>
            <button type="button" onClick={() => setQuantity((q) => q + 1)} className="text-lg leading-none text-ink transition-colors hover:text-primary" aria-label="Increase quantity">+</button>
          </div>
          <Button
            disabled={!canAdd}
            onClick={() => {
              onAdd(product, variantId, quantity);
              onOpenChange(false);
            }}
            className="flex-1 rounded-full"
          >
            Add — {formatMoney(unitPrice * quantity, currency)}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 4: `ShopBrowser`** — the client shell (search + grid + sheet + cart), mirroring `StorefrontMenu.tsx`'s wiring exactly:

```tsx
// src/app/_components/storefront/templates/shop/ShopBrowser.tsx
"use client";
import { useEffect, useState } from "react";
import type { PublishedMenu } from "@/server/catalog/schema";
import { addLine, loadCart, setLineQuantity, cartSubtotal, type Cart } from "@/app/_components/cart";
import { type MenuProduct } from "@/app/_components/storefront/ProductCard";
import { CartBar } from "@/app/_components/storefront/CartBar";
import { BranchPickSheet } from "@/app/_components/storefront/BranchPickSheet";
import { CartDrawer } from "@/app/_components/storefront/CartDrawer";
import { SectionHeader } from "@/app/_components/storefront/SectionHeader";
import { ShopProductCard } from "./ShopProductCard";
import { RetailProductSheet } from "./RetailProductSheet";
import { filterCatalog } from "./shop-search";

export function ShopBrowser({
  menu, branchId, slug, orderingEnabled, branches, currency, preorderOnly,
}: {
  menu: PublishedMenu;
  branchId: string | null;
  slug: string;
  orderingEnabled: boolean;
  preorderOnly: boolean;
  branches: { id: string; name: string; open: boolean }[];
  currency: string;
}) {
  const [cart, setCart] = useState<Cart>({ branchId: null, lines: [] });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeProduct, setActiveProduct] = useState<MenuProduct | null>(null);
  const [branchPickFor, setBranchPickFor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const needsBranchPick = branchId === null && branches.length > 1;

  useEffect(() => {
    const onChange = () => setCart(loadCart());
    onChange();
    window.addEventListener("serveos-cart-changed", onChange);
    return () => window.removeEventListener("serveos-cart-changed", onChange);
  }, []);

  function add(p: MenuProduct, variantId: string | null, quantity: number) {
    const v = variantId ? p.variants.find((x) => x.id === variantId) : null;
    setCart(addLine(branchId, {
      productId: p.id,
      variantId: v?.id,
      variantNameEn: v?.nameEn,
      nameEn: p.nameEn, nameAr: p.nameAr, quantity,
      unitPrice: v ? v.price : p.effectivePrice,
      selectedOptionIds: [],
      modifierSummaryEn: v?.nameEn ?? "", // CartDrawer renders this as the line summary
    }));
  }

  const itemCount = cart.lines.reduce((s, l) => s + l.quantity, 0);
  const visible = filterCatalog(menu.categories, query);

  return (
    <>
      <div className="sticky top-0 z-20 -mx-4 bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products or brands…"
          aria-label="Search products"
          className="w-full rounded-full border border-border bg-card px-4 py-2.5 text-sm text-ink outline-none transition-colors focus:border-primary/60"
        />
      </div>

      {visible.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">No products match “{query}”.</p>
      )}

      {visible.map((cat) => (
        <div key={cat.id} id={`category-${cat.id}`} className="scroll-mt-32 py-6">
          <SectionHeader eyebrow={cat.nameAr} title={cat.nameEn} count={cat.products.length} />
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {cat.products.map((p) => (
              <ShopProductCard
                key={p.id}
                product={p}
                interactive={orderingEnabled}
                onOpen={() => (needsBranchPick ? setBranchPickFor(p.id) : setActiveProduct(p))}
                currency={currency}
              />
            ))}
          </div>
        </div>
      ))}

      {orderingEnabled && (
        <>
          <RetailProductSheet
            product={activeProduct}
            open={activeProduct !== null}
            onOpenChange={(open) => !open && setActiveProduct(null)}
            onAdd={add}
            currency={currency}
          />
          <BranchPickSheet
            branches={branches}
            open={branchPickFor !== null}
            onOpenChange={(o) => !o && setBranchPickFor(null)}
            productId={branchPickFor}
          />
          <CartBar count={itemCount} subtotal={cartSubtotal(cart.lines)} onOpen={() => setDrawerOpen(true)} currency={currency} />
          <CartDrawer
            cart={cart}
            slug={slug}
            currency={currency}
            preorderOnly={preorderOnly}
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            onSetQuantity={(i, q) => setCart(setLineQuantity(i, q))}
          />
        </>
      )}
    </>
  );
}
```

- [ ] **Step 5: Catalog slot in `StorefrontShell`** — read the shell first; it currently renders `<StorefrontMenu …/>` (or the empty state) inside its catalog section. Add an optional prop and use it:

```tsx
export type StorefrontTemplateProps = {
  // ...existing fields unchanged...
  /** Shop verticals inject their catalog UI here; undefined = restaurant menu. */
  catalog?: React.ReactNode;
};
```

In the shell body, where the catalog section renders, keep the existing empty-state branch (`menu.categories.length === 0 → EmptyState(config.emptyMenuTitle/Desc)`) and change only the non-empty branch:

```tsx
          {props.catalog ?? (
            <StorefrontMenu
              /* the exact existing props — do not change them */
            />
          )}
```

- [ ] **Step 6: Shop wrappers pass the catalog** — update the three shop-vertical wrappers identically (retail shown; pharmacy/timber differ only in their `VERTICAL_ACCENTS`/`VERTICAL_STOREFRONT_COPY` keys, which they already reference):

```tsx
// src/app/_components/storefront/templates/RetailStorefront.tsx
import { StorefrontShell, type StorefrontTemplateProps } from "./StorefrontShell";
import { VERTICAL_ACCENTS, VERTICAL_STOREFRONT_COPY } from "@/server/verticals";
import { ShopBrowser } from "./shop/ShopBrowser";

export function RetailStorefront(props: Omit<StorefrontTemplateProps, "accent" | "config" | "catalog">) {
  return (
    <StorefrontShell
      {...props}
      accent={VERTICAL_ACCENTS.retail}
      config={VERTICAL_STOREFRONT_COPY.retail}
      catalog={
        <ShopBrowser
          menu={props.menu}
          branchId={props.activeBranch?.id ?? null}
          slug={props.slug}
          orderingEnabled={props.orderingEnabled && !props.paused}
          preorderOnly={props.openState !== null && !props.openState.open && !props.paused}
          branches={props.branchSummaries}
          currency={props.tenant.currency}
        />
      }
    />
  );
}
```

(Verify the exact prop names against the shell's `StorefrontTemplateProps` — `orderingEnabled`/`paused`/`openState`/`branchSummaries` all exist there; mirror how the shell itself computes the same values for `StorefrontMenu`.)

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npm run test && npm run test:e2e -- tests/e2e/menu.spec.ts`
Expected: all PASS — restaurant storefront unchanged (slot defaults to `StorefrontMenu`); shop e2e comes with the seed in Task 15.

- [ ] **Step 8: Commit**

```bash
git add src/app/_components/storefront/templates
git commit -m "feat(storefront): shop catalog UI (search, dense grid, stock badges, variant picker) in retail/pharmacy/timber templates"
```

---

### Task 10: Checkout breakdown, variant lines, out-of-stock surfacing, tracking labels

**Files:**
- Modify: `src/app/checkout/page.tsx`
- Modify: `src/app/checkout/CheckoutForm.tsx`
- Modify: `src/lib/order-status.ts` (+ its test)
- Modify: `src/app/order/[token]/page.tsx`

**Interfaces:**
- Consumes: `computeOrderTotals`, `CheckoutPricing` (Task 5); `getCheckoutPricing` (Task 5); cart variant fields (Task 7); `getVerticalTerms` (Task 1). API already accepts `variantId` (Task 6).
- Produces: `CheckoutForm` prop change `vatRate: number` → `pricing: CheckoutPricing`; `statusLabel`-style overrides `{ preparing?: string; ready?: string }` in `src/lib/order-status.ts`.

- [ ] **Step 1: Server side** — in `src/app/checkout/page.tsx`, replace the `getVatRate` import/usage with:

```ts
import { getCheckoutPricing } from "@/server/tenancy";
// ...
const pricing = await getCheckoutPricing(tenant.id);
```

and pass `pricing={pricing}` to `<CheckoutForm>` instead of `vatRate={...}`.

- [ ] **Step 2: `CheckoutForm` totals breakdown** — in `src/app/checkout/CheckoutForm.tsx`:
1. Prop change: `vatRate: number` → `pricing: CheckoutPricing` (`import { computeOrderTotals, type CheckoutPricing } from "@/lib/order-totals";`).
2. Locate the existing order-summary section (it renders subtotal/VAT/delivery rows from `vatRate`); replace its math with:

```tsx
  const deliveryFee = fulfillment === "delivery"
    ? Number(areas.find((a) => a.id === areaId)?.deliveryFee ?? 0)
    : 0;
  const totals = computeOrderTotals(pricing, cartSubtotal(cart.lines), deliveryFee);
```

and its rows with (styling: match the existing summary rows' classes):

```tsx
  <div className="flex justify-between text-sm"><span>Subtotal</span><span>{formatMoney(totals.subtotal, currency)}</span></div>
  {totals.serviceChargeAmount > 0 && (
    <div className="flex justify-between text-sm"><span>Service charge</span><span>{formatMoney(totals.serviceChargeAmount, currency)}</span></div>
  )}
  {totals.vatAmount > 0 && (
    <div className="flex justify-between text-sm">
      <span>{totals.vatIncludedInPrices ? `VAT ${totals.vatRate}% (included)` : `VAT ${totals.vatRate}%`}</span>
      <span>{formatMoney(totals.vatAmount, currency)}</span>
    </div>
  )}
  {fulfillment === "delivery" && (
    <div className="flex justify-between text-sm"><span>Delivery</span><span>{formatMoney(totals.deliveryFee, currency)}</span></div>
  )}
  <div className="flex justify-between font-semibold"><span>Total</span><span>{formatMoney(totals.total, currency)}</span></div>
```

(The `currency` prop: `CheckoutForm` currently formats with `formatMoney` — keep whatever currency source it already uses.)
3. In the submit handler's POST body, extend each line with `variantId: l.variantId` (cart lines carry it since Task 7).
4. Out-of-stock surfacing: the API returns 422 `{ error, code }`. In the existing error handling after a non-ok response, keep setting `setError(data.error)` — `OutOfStockError.messageFor` already names the product. Add a stock-specific hint:

```ts
  if (data.code === "out_of_stock") {
    setError(`${data.error} — please remove it from your cart or reduce the quantity.`);
  } else {
    setError(data.error ?? "Something went wrong");
  }
```

- [ ] **Step 3: Status label overrides** — `src/lib/order-status.ts` exports `orderStatusMeta(status: OrderStatus): OrderStatusMeta` backed by a `MAP` of `{ label, badgeClass }`. Add an optional overrides parameter:

```ts
export type StatusLabelOverrides = { preparing?: string; ready?: string };

export function orderStatusMeta(status: OrderStatus, overrides?: StatusLabelOverrides): OrderStatusMeta {
  const base = MAP[status] ?? { label: String(status), badgeClass: badge("completed") };
  if (status === "preparing" && overrides?.preparing) return { ...base, label: overrides.preparing };
  if (status === "ready" && overrides?.ready) return { ...base, label: overrides.ready };
  return base;
}
```

Extend `src/lib/order-status.test.ts` with:

```ts
  it("applies vertical overrides to preparing/ready labels only", () => {
    expect(orderStatusMeta("preparing", { preparing: "Being packed" }).label).toBe("Being packed");
    expect(orderStatusMeta("ready", { ready: "Ready for collection" }).label).toBe("Ready for collection");
    expect(orderStatusMeta("pending", { preparing: "Being packed" }).label).toBe("Pending");
    expect(orderStatusMeta("preparing").label).toBe("Preparing"); // no overrides = unchanged
  });
```

(The restaurant registry values in Task 1 already equal the current `MAP` labels — "Preparing"/"Ready" — so restaurant tenants see byte-identical status copy.)

- [ ] **Step 4: Tracking page** — in `src/app/order/[token]/page.tsx`, the page already loads the tenant to render the order; derive overrides and pass them wherever `statusLabel` (or the timeline component) is used:

```ts
import { getVerticalTerms, type VerticalId } from "@/server/verticals";
const terms = getVerticalTerms(tenant.vertical as VerticalId);
const statusOverrides = { preparing: terms.statusPreparing.en, ready: terms.statusReady.en };
```

For restaurants the overrides equal the current strings ("Being prepared"/"Ready" — align the registry values in Task 1 with the exact strings currently in `order-status.ts` when you read it; if they differ, update the **registry** strings to match the restaurant status quo, never the other way).

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit && npm run test -- src/lib`
Expected: PASS.
Then manually: `npm run dev`, place a restaurant order end-to-end on `roma.serveos.localhost:3000` — breakdown shows Subtotal/VAT/Total identical to before.

- [ ] **Step 6: Commit**

```bash
git add src/app/checkout src/lib/order-status.ts src/lib/order-status.test.ts src/app/order
git commit -m "feat(checkout): totals breakdown from computeOrderTotals, variant lines, out-of-stock surfacing, vertical status labels"
```
---

### Task 11 (REVISED): Admin queue shows the vertical

Registration is DONE — the merged scaffold ships `registerTenant` with a required, validated `vertical`, the 4-card register picker, and tests covering persistence + rejection of invalid values. Do not touch onboarding or the register page. What remains is surfacing the vertical to the platform admin.

**Files:**
- Modify: `src/server/platform/` (the service behind `listPendingApplications` — read it first)
- Modify: `src/app/admin/page.tsx`
- Test: extend `src/server/platform/service.test.ts`

**Interfaces:**
- Consumes: the merged `tenants.vertical`; `registerTenant` (in tests).
- Produces: `listPendingApplications()` rows gain `vertical: string`.

- [ ] **Step 1: Write the failing test** — append to `src/server/platform/service.test.ts` (mirror its existing setup, which already registers tenants via `registerTenant`):

```ts
  it("pending applications include the tenant vertical", async () => {
    const { tenantId } = await registerTenant({ restaurantName: "Wood & Co", slug: "adm-timber", country: "EG", ownerName: "O", email: "o@adm-timber.com", password: "x", vertical: "timber" });
    const pending = await listPendingApplications();
    const row = pending.find((p) => p.tenantId === tenantId);
    expect(row?.vertical).toBe("timber");
  });
```

Run: `npm run test -- src/server/platform` → FAIL (`vertical` not on the row type).

- [ ] **Step 2: Implement** — in the platform service, add `vertical` to `listPendingApplications`'s selected fields (the query already joins `tenants`; select `tenants.vertical`) and to its returned row type. Run the test again → PASS.

- [ ] **Step 3: Render the chip** — in `src/app/admin/page.tsx`:

```tsx
            <strong>{p.tenantName}</strong> — {p.slug}.serveos.com
            <span style={{ marginLeft: 8, padding: "2px 8px", background: "#eef", borderRadius: 999, fontSize: 12 }}>{p.vertical}</span>
```

Also update the `<h1>Pending restaurants</h1>` → `<h1>Pending applications</h1>`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run test -- src/server/platform`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/platform src/app/admin
git commit -m "feat(admin): pending-application queue shows the tenant vertical"
```

---

### Task 12: Dashboard — vertical terminology + capability-adaptive product form

**Files:**
- Modify: `src/components/dashboard/nav-items.ts`
- Modify: `src/app/dashboard/layout.tsx`
- Modify: `src/app/dashboard/menu/products/[id]/page.tsx`
- Modify: `src/app/dashboard/menu/products/actions.ts`
- Modify: `src/app/dashboard/menu/page.tsx` (stock quick-adjust)
- Create: `src/app/dashboard/menu/products/[id]/VariantsEditor.tsx` (server-rendered card, forms post to actions)

**Interfaces:**
- Consumes: `getVerticalTerms`, `getCapabilities`, `VerticalId` (Task 1); `listVariants`, `upsertVariant`, `deleteVariant`, `setProductStock` (Task 3); extended `UpdateProductInput` (Task 3).
- Produces: `dashboardNavItems(roleKeys: RoleKey[], catalogLabel?: string)`; server actions `upsertVariantAction(productId, formData)`, `deleteVariantAction(productId, variantId)`, `setProductStockAction(productId, formData)`.

- [ ] **Step 1: Nav label** — in `src/components/dashboard/nav-items.ts`:

```ts
export function dashboardNavItems(roleKeys: RoleKey[], catalogLabel = "Menu"): NavItem[] {
```

and the menu entry becomes `items.push({ label: catalogLabel, href: "/dashboard/menu", icon: "utensils" });`

In `src/app/dashboard/layout.tsx`:

```ts
import { getVerticalTerms, type VerticalId } from "@/server/verticals";
// after tenant loads:
const terms = getVerticalTerms((tenant?.vertical ?? "restaurant") as VerticalId);
const items = dashboardNavItems(roleKeys, terms.catalogNoun.en);
```

- [ ] **Step 2: Product actions** — in `src/app/dashboard/menu/products/actions.ts`:
1. `updateProductAction`: pass retail fields through only when present, so restaurant forms (which don't render them) don't clobber values:

```ts
  const trackStock = formData.get("trackStock") === "true";
  await updateProduct(tenantId, productId, {
    // ...existing fields unchanged...
    ...(formData.has("brand") ? { brand: formData.get("brand") ? String(formData.get("brand")) : null } : {}),
    ...(formData.has("sku") ? { sku: formData.get("sku") ? String(formData.get("sku")) : null } : {}),
    ...(formData.has("trackStock") || formData.has("stockQuantity")
      ? { trackStock, stockQuantity: trackStock && formData.get("stockQuantity") !== null && formData.get("stockQuantity") !== "" ? Number(formData.get("stockQuantity")) : null }
      : {}),
  });
```

(Checkbox caveat: an unchecked checkbox is absent from FormData. Pair it with a hidden marker input `<input type="hidden" name="stockQuantity" value="" />`-style presence, or simpler: always render a hidden `<input type="hidden" name="retailFields" value="true" />` in the retail form and gate on `formData.has("retailFields")` instead of per-field `has()` — use this simpler variant.)
2. New actions at the end of the file:

```ts
export async function upsertVariantAction(productId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  const { upsertVariant } = await import("@/server/catalog/variants");
  const stockRaw = formData.get("stockQuantity");
  await upsertVariant(tenantId, productId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    sku: formData.get("sku") ? String(formData.get("sku")) : null,
    price: String(formData.get("price")),
    stockQuantity: stockRaw !== null && stockRaw !== "" ? Number(stockRaw) : null,
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteVariantAction(productId: string, variantId: string) {
  const { tenantId } = await requireMenuPermission();
  const { deleteVariant } = await import("@/server/catalog/variants");
  await deleteVariant(tenantId, variantId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function setProductStockAction(productId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  const { setProductStock } = await import("@/server/catalog/variants");
  const raw = formData.get("stockQuantity");
  await setProductStock(tenantId, productId, raw !== null && raw !== "" ? Number(raw) : null);
  revalidatePath("/dashboard/menu");
}
```

(Use top-level static imports rather than dynamic ones — shown compact here.)

- [ ] **Step 3: VariantsEditor card** — mirrors the modifier-groups card structure of the edit page:

```tsx
// src/app/dashboard/menu/products/[id]/VariantsEditor.tsx
import { Plus } from "lucide-react";
import type { ProductVariant } from "@/server/catalog";
import { upsertVariantAction, deleteVariantAction } from "../actions";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function VariantsEditor({ productId, variants }: { productId: string; variants: ProductVariant[] }) {
  return (
    <>
      <h2 className="eyebrow text-primary mb-3">Variants</h2>
      <div className="space-y-4 max-w-2xl mb-6">
        <Card className="p-5">
          {variants.length === 0 && (
            <p className="text-sm text-muted-foreground mb-3">No variants yet — the product sells at its base price. Add variants (size, color, pack) each with its own price and stock.</p>
          )}
          <ul className="text-sm divide-y">
            {variants.map((v) => (
              <li key={v.id} className="py-2 flex items-center justify-between gap-2">
                <span>
                  {v.nameEn} <span className="text-muted-foreground" dir="rtl">/ {v.nameAr}</span>
                  {v.sku && <span className="ml-2 font-mono text-xs text-muted-foreground">{v.sku}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-mono text-xs">{Number(v.price).toFixed(2)}</span>
                  <span className="text-xs text-muted-foreground">{v.stockQuantity === null ? "untracked" : `${v.stockQuantity} in stock`}</span>
                  <ToastForm action={deleteVariantAction.bind(null, productId, v.id)} successMessage="Variant removed">
                    <SubmitButton variant="ghost" size="sm" className="text-destructive hover:text-destructive">Remove</SubmitButton>
                  </ToastForm>
                </span>
              </li>
            ))}
          </ul>
          <ToastForm action={upsertVariantAction.bind(null, productId)} successMessage="Variant saved" className="flex flex-wrap items-end gap-2 mt-3">
            <Input name="nameEn" placeholder="Variant (EN)" required className="w-36" />
            <Input name="nameAr" placeholder="Variant (AR)" dir="rtl" required className="w-36" />
            <Input name="sku" placeholder="SKU" className="w-28" />
            <Input name="price" type="number" step="0.01" min="0" placeholder="Price" required className="w-24" />
            <Input name="stockQuantity" type="number" min="0" placeholder="Stock" className="w-24" />
            <SubmitButton variant="outline" size="sm"><Plus className="size-4" />Add variant</SubmitButton>
          </ToastForm>
        </Card>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Capability-adaptive edit page** — in `src/app/dashboard/menu/products/[id]/page.tsx`:
1. Load capabilities + variants:

```ts
import { getTenantById } from "@/server/tenancy";
import { getCapabilities, type VerticalId } from "@/server/verticals";
import { listVariants } from "@/server/catalog";
import { VariantsEditor } from "./VariantsEditor";
// in the component body, after requireDashboardUser:
const tenant = await getTenantById(ctx.tenantId);
const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
const variants = caps.variants ? await listVariants(ctx.tenantId, id) : [];
```

2. Inside the product form, when `caps.variants`, add after the base-price field:

```tsx
          {caps.variants && (
            <>
              <input type="hidden" name="retailFields" value="true" />
              <div className="grid md:grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor="brand">Brand</Label>
                  <Input id="brand" name="brand" defaultValue={product.brand ?? ""} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="sku">SKU</Label>
                  <Input id="sku" name="sku" defaultValue={product.sku ?? ""} />
                </div>
              </div>
              <div className="flex items-end gap-4">
                <label className="flex items-center gap-2 text-sm h-9">
                  <input type="checkbox" name="trackStock" value="true" defaultChecked={product.trackStock} className="size-4 accent-(--color-primary)" />
                  Track stock (product without variants)
                </label>
                <div className="grid gap-1.5 max-w-32">
                  <Label htmlFor="stockQuantity">Stock</Label>
                  <Input id="stockQuantity" name="stockQuantity" type="number" min="0" defaultValue={product.stockQuantity ?? ""} />
                </div>
              </div>
            </>
          )}
```

3. Wrap the whole "Modifier groups" section (heading + cards) in `{caps.modifiers && (<>...</>)}` and render `{caps.variants && <VariantsEditor productId={id} variants={variants} />}` in its place for retail.

- [ ] **Step 5: Stock quick-adjust in the product list** — read `src/app/dashboard/menu/page.tsx` first. For retail tenants (`caps.variants`), add next to each product row's price a compact inline form:

```tsx
              {caps.stockTracking && p.trackStock && (
                <ToastForm action={setProductStockAction.bind(null, p.id)} successMessage="Stock updated" className="flex items-center gap-1.5">
                  <Input name="stockQuantity" type="number" min="0" defaultValue={p.stockQuantity ?? ""} className="w-20 h-8" aria-label={`Stock for ${p.nameEn}`} />
                  <SubmitButton variant="outline" size="sm">Set</SubmitButton>
                </ToastForm>
              )}
```

(Load `tenant`/`caps` at the top of that page the same way as Step 4; variant-level stock is adjusted on the product edit page.)

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npm run test`
Expected: PASS. Then manually: `npm run dev` → log in as `owner@roma.com` → nav still says "Menu", product page shows modifier groups, NO brand/SKU/stock fields (restaurant regression).

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/nav-items.ts src/app/dashboard
git commit -m "feat(dashboard): vertical terminology + capability-adaptive product form with variants editor and stock quick-adjust"
```

---

### Task 13: Taxes settings tab

**Files:**
- Modify: `src/app/dashboard/settings/tabs.ts`
- Create: `src/app/dashboard/settings/taxes/page.tsx`
- Create: `src/app/dashboard/settings/taxes/actions.ts`

**Interfaces:**
- Consumes: `getCheckoutPricing`, `setVatEnabled`, `setVatRate`, `setPricesIncludeVat`, `setServiceChargeRate` (Task 5, all exported from `@/server/tenancy`); `getCapabilities` (Task 1); `requireDashboardUser` + `authorize` (mirror `src/app/dashboard/settings/fulfillment/` for the permission pattern — use `"fulfillment:manage"`).
- Produces: `/dashboard/settings/taxes` page.

- [ ] **Step 1: Register the tab** — in `SETTINGS_TABS` after "Fulfillment":

```ts
  { label: "Taxes", href: "/dashboard/settings/taxes", permission: "fulfillment:manage" },
```

- [ ] **Step 2: Actions**

```ts
// src/app/dashboard/settings/taxes/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getTenantById, setVatEnabled, setVatRate, setPricesIncludeVat, setServiceChargeRate } from "@/server/tenancy";
import { getCapabilities, type VerticalId } from "@/server/verticals";

export async function saveTaxSettingsAction(formData: FormData) {
  const { tenantId, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "fulfillment:manage");
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);

  await setVatEnabled(tenantId, formData.get("vatEnabled") === "true");
  const rate = Number(formData.get("vatRate"));
  if (!Number.isNaN(rate) && rate >= 0 && rate <= 100) await setVatRate(tenantId, rate);
  await setPricesIncludeVat(tenantId, formData.get("pricesIncludeVat") === "true");

  if (caps.serviceCharge) {
    const sc = formData.get("serviceChargeRate");
    await setServiceChargeRate(tenantId, sc !== null && sc !== "" ? Number(sc) : null);
  }
  revalidatePath("/dashboard/settings/taxes");
}
```

- [ ] **Step 3: Page**

```tsx
// src/app/dashboard/settings/taxes/page.tsx
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getTenantById, getCheckoutPricing } from "@/server/tenancy";
import { getCapabilities, type VerticalId } from "@/server/verticals";
import { saveTaxSettingsAction } from "./actions";
import { PageHeader } from "@/components/dashboard/PageHeader";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function TaxesSettingsPage() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "fulfillment:manage");
  const tenant = await getTenantById(ctx.tenantId);
  const caps = getCapabilities((tenant?.vertical ?? "restaurant") as VerticalId);
  const pricing = await getCheckoutPricing(ctx.tenantId);

  return (
    <>
      <PageHeader eyebrow="Settings" title="Taxes & charges" />
      <Card className="p-5 max-w-2xl">
        <ToastForm action={saveTaxSettingsAction} successMessage="Tax settings saved" className="grid gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="vatEnabled" value="true" defaultChecked={pricing.vatEnabled} className="size-4 accent-(--color-primary)" />
            Charge VAT on orders
          </label>
          <div className="grid gap-1.5 max-w-32">
            <Label htmlFor="vatRate">VAT rate (%)</Label>
            <Input id="vatRate" name="vatRate" type="number" step="0.5" min="0" max="100" defaultValue={pricing.vatRate} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="pricesIncludeVat" value="true" defaultChecked={pricing.pricesIncludeVat} className="size-4 accent-(--color-primary)" />
            My prices already include VAT (VAT shown as an informational line)
          </label>
          {caps.serviceCharge && (
            <div className="grid gap-1.5 max-w-32">
              <Label htmlFor="serviceChargeRate">Service charge (%)</Label>
              <Input id="serviceChargeRate" name="serviceChargeRate" type="number" step="0.5" min="0" max="100" defaultValue={pricing.serviceChargeRate || ""} placeholder="Off" />
            </div>
          )}
          <div><SubmitButton>Save</SubmitButton></div>
        </ToastForm>
      </Card>
    </>
  );
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`. Then manually: dev server → Settings → Taxes: restaurant tenant sees the service-charge field; set service charge 10%, place an order, breakdown shows the line; set it back to Off.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/settings
git commit -m "feat(settings): taxes & charges tab with capability-gated service charge"
```

---

### Task 14: Storefront QR card on the dashboard home

**Files:**
- Modify: `src/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `qrcode` (already in dependencies, with `@types/qrcode`); `getEnv().ROOT_DOMAIN` from `@/env`; tenant slug from the page's existing data.

- [ ] **Step 1: Add the card** — read `src/app/dashboard/page.tsx` first (Home; it already loads the tenant). Add:

```tsx
import QRCode from "qrcode";
import { getEnv } from "@/env";
// in the component body:
const storefrontUrl = `https://${tenant.slug}.${getEnv().ROOT_DOMAIN}`;
const qrDataUrl = await QRCode.toDataURL(storefrontUrl, { width: 512, margin: 1 });
```

and render, following the page's existing Card layout:

```tsx
      <Card className="p-5 max-w-sm">
        <h2 className="text-sm font-medium text-ink mb-1">Your storefront QR</h2>
        <p className="text-xs text-muted-foreground mb-3">Print it for tables, counters, packaging, or the shop window.</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qrDataUrl} alt={`QR code for ${storefrontUrl}`} className="size-40 rounded-lg border border-border" />
        <div className="mt-3 flex items-center gap-3">
          <a href={qrDataUrl} download={`${tenant.slug}-storefront-qr.png`} className="text-sm font-medium text-primary hover:underline">Download PNG</a>
          <span className="text-xs text-muted-foreground">{storefrontUrl}</span>
        </div>
      </Card>
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`. Manually: dashboard Home shows a scannable QR resolving to the storefront URL.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat(dashboard): downloadable storefront QR card"
```

---

### Task 15: Retail showcase seed + shop e2e smoke

**Files:**
- Create: `scripts/seed-retail-showcase.ts`
- Create: `tests/e2e/shop.spec.ts`

**Interfaces:**
- Consumes: everything shipped above. Read `scripts/seed-showcase.ts` first and mirror its structure (env loading, `withTenant` usage, idempotency approach).

- [ ] **Step 1: Seed script** — creates (idempotently) an ACTIVE retail tenant `nobio` with a hardware-store catalog:

```ts
// scripts/seed-retail-showcase.ts
import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });
import { eq } from "drizzle-orm";

/** Seeds a retail showcase tenant (slug: nobio) — hardware store with brands,
 * variants, and stock states. Idempotent: re-running wipes and recreates its
 * catalog only. Usage: npx tsx scripts/seed-retail-showcase.ts */
async function main() {
  const { db } = await import("../src/db/client");
  const { withTenant } = await import("../src/db/with-tenant");
  const { tenants } = await import("../src/server/tenancy/schema");
  const { categories, products, productVariants } = await import("../src/server/catalog/schema");
  const { seedDefaultPlans } = await import("../src/server/subscription/plans.seed");
  const { startTrial } = await import("../src/server/subscription/service");
  const { createBranch, updateBranchOrdering, createDeliveryArea } = await import("../src/server/branches/service");

  const IMG = (id: string) => `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;

  let [tenant] = await db.select().from(tenants).where(eq(tenants.slug, "nobio")).limit(1);
  if (!tenant) {
    [tenant] = await db.insert(tenants).values({
      slug: "nobio", name: "Nobio Hardware", country: "EG", currency: "EGP",
      status: "active", vertical: "retail",
      tagline: "Fittings, worktops & hardware — delivered same day",
      cuisine: "Hardware & fittings", // rendered as "Store type" for retail
    }).returning();
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

  const CATALOG = [
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
      const hasVariants = "variants" in item && Array.isArray(item.variants);
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
      if (hasVariants) {
        await withTenant(tid, async (tx) => {
          for (const [vi, v] of item.variants!.entries()) {
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
```

(TypeScript nit: give `CATALOG` an explicit type so `item.variants`/`item.stock` don't need non-null assertions — define `type SeedItem = { nameEn: string; nameAr: string; brand: string; price: string; stock?: number | null; variants?: Array<{ nameEn: string; nameAr: string; price: string; stock: number | null }> };`.)

Run: `npx tsx scripts/seed-retail-showcase.ts`
Expected: `Seeded retail showcase: nobio (<uuid>)`.

- [ ] **Step 2: Shop e2e smoke** — mirrors `tests/e2e/menu.spec.ts`'s host-header pattern:

```ts
// tests/e2e/shop.spec.ts
import { test, expect } from "@playwright/test";

const ROOT = "http://localhost:3000";

// Requires: npx tsx scripts/seed-retail-showcase.ts (tenant "nobio", vertical retail)

test("retail storefront renders the shop template", async ({ request }) => {
  const res = await request.get(ROOT, { headers: { host: "nobio.serveos.localhost" } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("Nobio Hardware");
  expect(html).toContain("Soft-Close Hinge");
  expect(html).toMatch(/search products/i);   // shop search bar (menu template has none)
  expect(html).toMatch(/out of stock/i);      // seeded out-of-stock product visible but flagged
});

test("restaurant storefront still renders the menu template (no search bar)", async ({ request }) => {
  const res = await request.get(ROOT, { headers: { host: "roma.serveos.localhost" } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).not.toMatch(/search products/i);
});
```

- [ ] **Step 3: Run e2e**

Run: `npm run test:e2e -- tests/e2e/shop.spec.ts tests/e2e/menu.spec.ts`
Expected: PASS.

- [ ] **Step 4: Full verification sweep**

Run: `npx tsc --noEmit && npm run lint && npm run test && npm run test:e2e`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-retail-showcase.ts tests/e2e/shop.spec.ts
git commit -m "feat(seed): nobio retail showcase tenant + shop template e2e smoke"
```

---

### Task 16: Mobile UI/UX polish pass — both storefront templates + checkout

**Files:**
- Create: `tests/e2e/storefront-responsive.spec.ts`
- Modify (as the audit finds issues): `src/app/_components/storefront/templates/shop/*`, `src/app/_components/storefront/*`, `src/app/checkout/CheckoutForm.tsx`, `src/app/globals.css`

**Interfaces:** none new — this is a verification-driven polish pass. Tests define "done".

Storefronts are installable PWAs used almost entirely on phones (EG/SA market); the shop template is brand new and has never had a mobile pass. Write the responsive tests FIRST, then fix what fails, then sweep the visual checklist.

Prerequisites: dev DB seeded with `roma` (`npm run db:seed`) and `nobio` (`npx tsx scripts/seed-retail-showcase.ts`). Chromium resolves `*.localhost` to loopback, so `page.goto("http://nobio.serveos.localhost:3000/")` works without `/etc/hosts` entries (the README documents the fallback).

- [ ] **Step 1: Write the responsive storefront tests**

```ts
// tests/e2e/storefront-responsive.spec.ts
import { test, expect } from "@playwright/test";

const SHOP = "http://nobio.serveos.localhost:3000";
const MENU = "http://roma.serveos.localhost:3000";

// Requires: npm run db:seed (roma) and npx tsx scripts/seed-retail-showcase.ts (nobio)

test.describe("storefront mobile (360px)", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  async function assertNoHScroll(page: import("@playwright/test").Page, url: string) {
    await page.goto(url);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${url}`).toBeLessThanOrEqual(1);
  }

  test("menu and shop templates do not overflow horizontally", async ({ page }) => {
    await assertNoHScroll(page, MENU);
    await assertNoHScroll(page, SHOP);
  });

  test("shop: search stays usable while scrolling and filters the grid", async ({ page }) => {
    await page.goto(SHOP);
    const search = page.getByRole("searchbox", { name: "Search products" });
    await expect(search).toBeVisible();
    await page.mouse.wheel(0, 1200);
    await expect(search).toBeInViewport(); // sticky header holds
    await search.fill("hinge");
    await expect(page.getByText("Soft-Close Hinge")).toBeVisible();
    await expect(page.getByText("Oak Compact Worktop")).toBeHidden();
  });

  test("shop: add a variant to the cart from a phone viewport", async ({ page }) => {
    await page.goto(SHOP);
    await page.getByRole("button", { name: "Soft-Close Hinge" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByText("35mm", { exact: true }).click();
    await sheet.getByRole("button", { name: /^Add/ }).click();
    // CartBar appears and does not cover the last product row (content keeps bottom padding)
    await expect(page.getByText(/1 item/i)).toBeVisible();
  });

  test("shop: out-of-stock card is visible but not clickable", async ({ page }) => {
    await page.goto(SHOP);
    const card = page.getByRole("button", { name: "Matte Black Knob" });
    await expect(card).toBeVisible();
    await expect(card).toBeDisabled();
  });

  test("tap targets: product-card add buttons are at least 40px", async ({ page }) => {
    await page.goto(SHOP);
    const box = await page.getByRole("button", { name: "Standard Hinge" }).boundingBox();
    expect(box, "card renders").toBeTruthy();
    // the quantity/add affordances inside sheets are checked manually in Step 3
  });

  test("checkout page does not overflow and inputs do not trigger iOS zoom", async ({ page }) => {
    await page.goto(`${MENU}/checkout`);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    // font-size >= 16px on text inputs prevents iOS Safari auto-zoom
    const sizes = await page.$$eval("input", (els) =>
      els.map((el) => parseFloat(getComputedStyle(el).fontSize)),
    );
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
  });
});
```

(Adjust selectors to the real accessible names if they differ once rendered — e.g. the CartBar's item-count text — but keep every assertion; weakening a failing assertion is not a fix.)

- [ ] **Step 2: Run, then fix every failure**

Run: `npm run test:e2e -- tests/e2e/storefront-responsive.spec.ts`
Expected: some failures on first run — fix the components, not the tests. Likely candidates and their remedies:
- Horizontal overflow → find the offender with dev tools (`* { outline: 1px solid red }`), fix with `min-w-0`, `overflow-x-auto` on the strip containers, or `break-words`.
- iOS zoom → ensure inputs use `text-base` (16px) on mobile, `sm:text-sm` upward (check `src/components/ui/input.tsx` and the shop search input).
- Sticky search vs. CartBar stacking → search header `z-20`, CartBar keeps its existing higher z-index; content keeps `pb-32` so the bar never covers the last row.

- [ ] **Step 3: Manual visual sweep (dev server, responsive mode at 360/390/768px + one real phone if available)** — fix anything failing this checklist; touch only what the checklist flags:
- Safe areas: CartBar and sheet footers respect `env(safe-area-inset-bottom)` when installed as a PWA (add `pb-[env(safe-area-inset-bottom)]` to the fixed bottom bars if missing).
- Tap targets ≥ 44px for: sheet quantity −/+, variant rows, cart drawer quantity controls, checkout radio rows.
- Product grids: 2 columns at 360px with 12px gaps; images keep aspect ratio with no layout shift (`aspect-square` / `aspect-[4/3]` already set — verify).
- Long content: product names clamp (`line-clamp-2`), Arabic names render RTL correctly inside LTR cards, brand eyebrow truncates (`truncate`).
- Sheets: `RetailProductSheet` and `ProductSheet` scroll their body (not the page) when content exceeds the viewport; the Add footer stays pinned.
- Checkout on mobile: summary readable without sideways scrolling; error banner visible without scrolling when submission fails.
- Dashboard (retail): variants editor form wraps cleanly at 360px (inputs stack, no overflow); stock quick-adjust fits in the card list.
- Dark mode: shop template inherits the same token behavior as the menu template (no hardcoded light-only colors introduced in Task 9).

- [ ] **Step 4: Full e2e sweep**

Run: `npm run test:e2e`
Expected: all specs green, including the pre-existing `responsive.spec.ts` (dashboard) untouched.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/storefront-responsive.spec.ts src/app src/components
git commit -m "polish(storefront): mobile responsiveness pass for menu + shop templates and checkout"
```

---

## Spec Coverage Map

| Spec section | Tasks |
|---|---|
| §2 Verticals domain + discipline rule | 1 (registry), 3/5/6 (capability checks), 8/9 (dispatchers only name verticals) |
| §3 Data model (variants, product/order cols, RLS, stock semantics) | 2, 6 |
| §4 Storefront (dispatch, menu extraction, shop template, QR) | 8, 9, 14 |
| §5 Cart/checkout/ordering (variant lines, DB pricing, state machine untouched) | 6, 7, 10 |
| §6 Taxes & adjustments (computeOrderTotals, settings, snapshots, dashboard) | 5, 13 |
| §7 Dashboard & onboarding (terms, adaptive form, stock adjust, admin, seed; registration shipped by the merged scaffold) | 11, 12, 15 |
| Spec Revision 2 (4 verticals, single registry absorbing tenancy/verticals, shell catalog slot) | 1, 8, 9, 11 |
| §8 Errors (OutOfStock, InvalidVariant, CapabilityNotEnabled, migration safety) | 1, 2, 3, 6 |
| §9 Testing (registry completeness, RLS, race, restaurant-regression e2e, totals) | every task; race in 6, regression e2e in 8/15 |
| Mobile UI/UX & responsiveness (user addition, 2026-07-13) | 16 |

Deviation from spec (documented in Task 5): checkout-pricing defaults are "preserve current behavior" (`vatEnabled: true`) rather than literally "all off", because VAT is already always applied today; and `vatAmount` is rounded before summation so breakdown lines sum exactly to the total.



