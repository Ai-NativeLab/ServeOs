# Vertical Storefront Templates — Design

**Date:** 2026-07-13
**Status:** Approved (brainstorming complete)
**Scope of this delivery:** vertical framework + restaurant migration + retail vertical

## 1. Problem & Goal

ServeOS today is a restaurant-only platform: the storefront is a menu, the catalog is
categories → products → modifier groups, and all copy assumes food. We want to sell
ServeOS to retailers and pharmacies, which browse, buy, and manage differently.

**Goal:** make the platform vertical-aware. Each vertical (restaurant, retail, and later
pharmacy) gets its own storefront template, terminology, and catalog behavior on top of a
single shared core (tenancy, branches, ordering, billing, entitlements, WhatsApp, PWA).

**Decisions made during brainstorming:**

- Vertical-aware platform — not visual reskins, not a plugin engine.
- First delivery: framework + migrate restaurants onto it + ship retail end-to-end.
  Pharmacy is a later vertical that builds on retail's variants + stock model plus
  prescription workflows (Yodawy/Chefaa pattern: prescription upload is an alternative
  order entry path, not a checkout add-on).
- One curated template per vertical with branding knobs (logo, colors, cover, tagline).
  No Shopify-style section editor.
- Dashboard: catalog management and terminology adapt per vertical; orders, analytics,
  branches, banners, and billing screens stay shared and unchanged.
- Retail fulfillment v1 keeps the existing local delivery/pickup + WhatsApp model.
  Carrier shipping (zones, rates, tracking numbers) is a later phase.
- Retail catalog v1 includes product variants (each a purchasable unit with its own
  price and stock) and stock tracking with storefront in/out-of-stock display.
- Taxes are vertical-aware: the vertical declares which checkout adjustment lines can
  apply (restaurant: VAT + service charge; retail: VAT); tenant settings hold
  enablement and rates. Per-line tax classes (pharmacy: exempt medicines vs taxed OTC)
  are designed for but deferred to the pharmacy phase.

**External references studied:** nobio.eu (retail storefront DNA: category drill-down,
brand/SKU cards, stock status, variants), Square Online (two vertical templates — retail
"Shop All" vs restaurant "Order Online" — over shared branding/layout machinery),
Yodawy/Chefaa (pharmacy order-entry paths, EG market), Shopify OS 2.0 (structure-as-data
vocabulary), Salla/Zid (Arabic-first theme markets, but not vertical-aware — our gap in
MENA), instamenu.in (QR-first entry; vertical-specific attributes as filters/badges).

## 2. Architecture: the `verticals` domain

New domain module `src/server/verticals/` (barrel export via `index.ts`, matching the
existing domain-module pattern). It exports a **static typed registry** — vertical
definitions are code, not database rows.

```ts
type VerticalKey = "restaurant" | "retail"; // "pharmacy" added later

interface VerticalDescriptor {
  key: VerticalKey;
  capabilities: {
    modifiers: boolean;       // restaurant: true,  retail: false
    variants: boolean;        // restaurant: false, retail: true
    stockTracking: boolean;   // restaurant: false, retail: true
    serviceCharge: boolean;   // restaurant: true,  retail: false
  };
  terminology: VerticalTerms; // en + ar: catalog noun, business noun, category noun,
                              // business-type label, empty states, status labels, ...
  storefront: { template: "menu" | "shop" };
  checkout: { adjustments: AdjustmentKind[] }; // restaurant: ["vat","service_charge"],
                                               // retail: ["vat"]
  badges: BadgeDefinition[];  // shared popular/new + vertical-specific extras
}
```

**Tenant association:** `tenants.vertical` — a Postgres enum column, default
`restaurant`. Existing tenants migrate with no data changes.

**The discipline rule (load-bearing):** shared services never branch on vertical names
(`tenant.vertical === "retail"` is forbidden outside the registry). They branch on
capabilities: `getCapabilities(tenant).stockTracking`. Only the registry and the two
template dispatchers (storefront page, dashboard catalog screens) mention vertical keys.
Adding pharmacy later must be: write a descriptor, write a template, add the
prescription capability — without editing every service. A unit test enforces registry
completeness (every vertical defines every terminology key and a template).

The existing `tenants.cuisine` column is kept as-is; its label becomes vertical-driven
("Cuisine" for restaurants, "Store type" for retail). Renaming the column is optional
and only done if free during migration.

## 3. Data model

One new table plus small column additions, all tenant-scoped with FORCE RLS via the
existing `withTenant()` pattern.

```
product_variants
  id               uuid pk
  tenant_id        uuid → tenants (cascade)
  product_id       uuid → products (cascade)
  name_en, name_ar text            -- "500g", "Red / L"
  sku              text null
  price            numeric         -- absolute price; a variant is a purchasable unit,
                                   -- NOT a delta on a base price
  stock_quantity   integer null    -- null = not tracked
  is_active        boolean default true
  sort_order       integer default 0
```

**`products` additions:** `brand` (text null), `sku` (text null), `stock_quantity`
(integer null — for simple retail products without variants), `track_stock` (boolean
default false).

**`order_items` additions:** `variant_id` (uuid null) plus denormalized
`variant_name_en` / `variant_name_ar` (same snapshot pattern as `selectedModifiers`).

**Modifiers vs variants:** both exist in schema; capabilities gate which one a tenant
can use. They are deliberately NOT unified: a modifier is a customization of one item
(price delta on a base); a variant is a distinct purchasable SKU with its own price and
stock. Restaurant products use modifier groups; retail products use variants.

**Stock semantics:** stock decrements atomically inside the existing place-order
transaction with a `stock_quantity >= quantity` guard in the UPDATE. A failed guard
raises `OutOfStockError`; no oversell under concurrent orders. Stock is only enforced
when the tenant capability `stockTracking` is on AND the product/variant tracks stock.
Cancelled orders restock (same transaction pattern on the cancel transition).

## 4. Storefront

**Dispatch:** `src/app/page.tsx` becomes a thin dispatcher — resolve tenant → look up
descriptor → render that vertical's template, passing shared data (tenant, branches,
banners, open state, entitlements, WhatsApp number). Hardcoded copy ("Restaurant not
found", "Menu coming soon") moves to descriptor terminology.

**Templates** live under `src/app/_components/templates/`:

- **`menu/` (restaurant):** today's storefront extracted verbatim — cinematic hero,
  scroll-spy category nav, featured cards, modifier product sheet, floating cart bar.
  Zero visual change for existing tenants; the existing Playwright smoke must pass
  unmodified as the regression proof.
- **`shop/` (retail):** new template with retail DNA — compact utility header with a
  search bar (client-side over the published catalog in v1), category grid drill-down
  (not one long scrolling menu), denser product grid cards showing brand, price, and
  in-stock/out-of-stock state, and a product sheet with a variant picker (each variant
  shows its own price and availability). Out-of-stock items stay visible but
  unpurchasable (grayed badge), never hidden.

**Shared primitives stay single-sourced** and are composed by templates, not forked:
Hero, OpenStateBanner, RecentOrderStrip, BranchSelector, banners strip, footer,
cart drawer/bar, checkout, order tracking, PWA manifest/installability.

**QR entry (both verticals):** a dashboard card to download the storefront QR code
(instamenu lesson; near-zero cost).

## 5. Cart, checkout, ordering

- `CartLine` gains optional `variantId` and `variantNameEn/Ar`. Line identity for
  merging is product + variant (restaurant lines remain product + selected options,
  unchanged). One cart model serves both templates. Persisted cart key stays the same;
  old carts load fine (missing variant fields = undefined).
- Checkout flow is structurally unchanged (pickup/delivery, delivery areas, cash,
  WhatsApp notification); only terminology adapts.
- Place-order validates that the variant exists, is active, and belongs to the product;
  unit price always comes from the DB (variant price, or product base price), never
  from the client. Stock guard as in §3.
- **The order state machine is untouched.** Both verticals share statuses; the tracking
  timeline and dashboard/POS labels relabel via terminology ("Being prepared" →
  "Being packed"). POS keeps working for both verticals without changes.

## 6. Taxes & checkout adjustments

Tax applicability is vertical-shaped; rates and registration are per-tenant and
per-country (EG VAT 14%, SA VAT 15%; small merchants below the registration threshold
charge nothing).

- The descriptor's `checkout.adjustments` declares which adjustment lines CAN apply for
  the vertical: restaurant → VAT + optional service charge; retail → VAT.
- Tenant settings (existing `tenant_settings.data` jsonb) declare whether they DO apply
  and at what rate: `vatEnabled`, `vatRate` (defaulted by tenant country),
  `pricesIncludeVat` (inclusive → VAT shown as an informational breakdown line;
  exclusive → VAT added at checkout; MENA storefronts usually display tax-inclusive
  prices), `serviceChargeRate` (capability-gated to restaurants).
- **One server-side function computes money:** `computeOrderTotals(tenant, lines,
  fulfillment)` produces the full breakdown (subtotal → adjustments → delivery fee →
  total). Place-order persists it; the checkout UI only renders it. The client never
  computes totals.
- `orders` gains snapshot columns: `tax_rate`, `tax_amount`, `service_charge_amount`
  (all nullable) — same denormalization pattern as other order fields.
- Dashboard gains a small "Taxes" settings section; visibility and labels are
  capability-driven.
- Existing tenants: all adjustments default off — order totals are byte-identical to
  today until a merchant enables them.
- **Pharmacy seam (later):** exempt medicines vs taxed OTC requires per-line tax
  classes — a `taxClass` on products/variants consumed by `computeOrderTotals`. The
  function signature is designed for this; v1 implements order-level rates only.

## 7. Dashboard & onboarding

- `getVerticalTerms(tenant)` feeds all dashboard labels (nav noun Menu/Products,
  Cuisine/Store type, status labels), en + ar, from the descriptor.
- **Product form adapts by capability:** restaurant tenants see the existing
  modifier-groups editor; retail tenants see a variants editor (name, SKU, price,
  stock, active, sort) plus brand/SKU/track-stock/stock fields on the product.
  Category management, image upload, publish/feature toggles stay shared.
- Retail product list gets an inline stock quick-adjust control.
- Orders, analytics, branches, banners, billing dashboard screens: unchanged.
- **Registration** gains a business-type picker (restaurant / retail) that sets
  `tenants.vertical`; the admin approval queue displays it. Vertical is fixed after
  approval; changing it later is an admin-only escape hatch, not a merchant feature.
- Plans/entitlements are unchanged; the same plans serve both verticals in v1.
- `scripts/seed-showcase.ts` gains a retail demo tenant alongside Roma.

## 8. Error handling

Typed errors following `src/shared/errors.ts` conventions, enforced at the service
layer (not just hidden in the UI):

- `OutOfStockError` — carries line identity and available quantity; the cart surfaces
  which line failed with a reduce/remove affordance and re-fetches availability.
- `InvalidVariantError` — variant missing, inactive, or not owned by the product.
- `CapabilityNotEnabledError` — e.g. adding a modifier group as a retail tenant or a
  variant as a restaurant tenant is rejected server-side (400).

Migration safety: `vertical` defaults to `restaurant`; `track_stock` defaults to false;
no backfill needed; existing tenants see zero behavior change.

## 9. Testing

- **Unit:** registry completeness (every vertical defines every terminology key and a
  template — fails when a future vertical is half-added); cart merge identity with
  variants; badge logic; stock guard arithmetic; `computeOrderTotals` breakdowns
  (VAT inclusive/exclusive, service charge, adjustments disabled → totals identical to
  the current computation).
- **Integration (Vitest + serveos_test DB, existing harness):** RLS isolation on
  `product_variants`; place-order uses DB variant price; concurrency test — two orders
  race for the last unit, exactly one succeeds and the other gets `OutOfStockError`;
  capability gating in the catalog service; cancel restocks.
- **E2E (Playwright):** existing restaurant storefront smoke passes unmodified
  (extraction regression proof); new shop-template smoke: browse → search → pick
  variant → cart → checkout → tracking.

## 10. Out of scope (explicitly)

- Pharmacy vertical (next delivery: descriptor + prescription-upload entry path +
  Rx/OTC flagging + pharmacist review, on top of retail's variant/stock model).
- Shopify-style section editor or multiple templates per vertical.
- Carrier shipping (zones, rates, tracking numbers) and shipping-specific order states.
- Vertical-specific plans/entitlements and vertical-specific analytics.
- WhatsApp-based catalog management (instamenu pattern) — candidate for a later phase.
- Per-line tax classes (pharmacy Rx-exempt vs OTC-taxed) and e-invoicing compliance
  (ZATCA in SA, ETA in Egypt) — the `computeOrderTotals` seam is built for both.
