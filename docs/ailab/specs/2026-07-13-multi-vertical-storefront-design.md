# Multi-Vertical Storefront — Design

**Date:** 2026-07-13
**Status:** Approved

## Goal

The marketing landing page now promotes ServeOS across four trades — restaurant, retail,
pharmacy, and timber — but the product only ships a single, restaurant-shaped storefront.
This work captures a tenant's **vertical** at signup and renders a **distinct storefront
template per vertical**, while leaving the working restaurant storefront intact and not
building any vertical-specific backend domain (barcodes, batch/expiry, dimensions, etc.).

The catalog/products/orders engine is already vertical-neutral (categories, products,
modifiers — not menu/dishes), so the templates differ in **terminology, accent, and a few
trade-specific labels**, not in data shape.

## Scope

**In scope**
- Add a `vertical` field to the tenant.
- Capture the vertical via a picker on the register page.
- Route the storefront to a per-vertical template.
- Relabel the storefront per vertical (headings, item noun, hero area label, WhatsApp CTA,
  empty states) and apply each trade's accent.
- Tests covering the schema, registration persistence, and template selection.

**Out of scope (explicitly "Soon", not built now)**
- Barcodes, variants, batch/expiry, units of measure, cut-to-order lists, prescriptions.
- Dashboard / POS / login / settings relabeling.
- Per-vertical catalog schema changes.

## Data model

`src/server/tenancy/schema.ts`:
- New enum `vertical` = `pgEnum("vertical", ["restaurant", "retail", "pharmacy", "timber"])`.
- New column on `tenants`: `vertical: vertical("vertical").notNull().default("restaurant")`.
- `cuisine` is retained (restaurant template still uses it).
- Export `VERTICAL_IDS` and `VerticalId` from a single source (see below).

`src/db/schema.ts`: no change (re-exports tenancy schema).

Migration: a Drizzle migration that adds the `vertical` column with default `restaurant`.
Existing and demo-seeded tenants default to `restaurant`, so behavior is unchanged for them.

## Shared vertical config

New file `src/server/tenancy/verticals.ts` (server-safe, no React):
- `VERTICAL_IDS = ["restaurant", "retail", "pharmacy", "timber"] as const` and `type VerticalId`.
- `VERTICAL_ACCENTS: Record<VerticalId, string>` — reuses the four tokens already present on
  the landing page (chart-1/2/4/5): restaurant `#F0522B`, retail `#2DD4C4`, pharmacy
  `#38D08C`, timber `#E8A33D`.
- `VERTICAL_STOREFRONT_COPY: Record<VerticalId, { menuHeading; itemNoun; whatsappCta: boolean; heroAreaLabel; notFoundTitle; emptyMenuTitle; emptyMenuDesc }>`.

This keeps storefront labeling decoupled from the marketing `verticals.ts` (which carries
rich landing copy + "Soon" roadmap flags). Accents stay consistent across marketing and
storefront by sharing the same constants.

## Capture at signup

`src/server/onboarding/service.ts`:
- `RegisterInput` gains `vertical: VerticalId`.
- Rename `registerRestaurant` → `registerTenant` (clearer now that we are multi-vertical).
  Update the single caller in `src/app/register/actions.ts`.
- Validate `vertical` is in `VERTICAL_IDS`; reject otherwise.
- Insert `vertical` into `tenants`.

`src/app/register/page.tsx`:
- Add a **4-card vertical picker** (Restaurant / Retail / Pharmacy / Timber) above the form.
- Selecting a card sets a hidden `vertical` input and **relabels the form**:
  - "Restaurant name" → "Shop name" (retail) / "Pharmacy name" (pharmacy) / "Yard name" (timber) / "Restaurant name" (restaurant).
  - Subdomain hint stays the same ("yours.serveos.com").
- Picker is self-contained (no dependency on the landing page switcher).
- The selected card's accent tints the submit button / active state.

`src/app/register/actions.ts`: pass `vertical` from the form into `registerTenant`.

## Storefront template selection

`src/app/page.tsx` (storefront branch only):
- After loading `tenant`, read `tenant.vertical`.
- `restaurant` → render `<RestaurantStorefront ... />` (existing JSX extracted verbatim).
- `retail` → `<RetailStorefront />`, `pharmacy` → `<PharmacyStorefront />`,
  `timber` → `<TimberStorefront />`.
- All templates receive the same data already loaded (tenant, banners, menu, branches,
  ordering flag, whatsapp number, popular ids) plus the resolved `verticalConfig`.

Data loading in `page.tsx` is **unchanged** — the per-vertical difference is presentation
only. The WhatsApp number is still fetched; non-restaurant templates simply choose not to
render the WhatsApp CTA based on `verticalConfig.whatsappCta`.

## Template structure (distinct files, shared shell)

New directory `src/app/_components/storefront/templates/`:
- `StorefrontShell.tsx` — shared layout: applies the vertical accent as a CSS variable /
  inline style on the root, renders `Hero`, `OpenStateBanner`, `RecentOrderStrip`, banners,
  optional `BranchSelector`, the menu/catalog section, and `StorefrontFooter`. Takes a
  `config` (accent + labels) and the menu/render props; exposes slots for trade-specific
  sections so a vertical can diverge later (e.g. timber cut-list) without forking the shell.
- `RestaurantStorefront.tsx` — extracted from `page.tsx` current storefront JSX, composed
  through `StorefrontShell` with the restaurant config. Behavior identical to today.
- `RetailStorefront.tsx`, `PharmacyStorefront.tsx`, `TimberStorefront.tsx` — thin files that
  render `StorefrontShell` with their vertical config. Reuse existing neutral components:
  `StorefrontMenu`, `ProductCard`, `CartBar`, `CategoryNav`, `OpenStateBanner`,
  `BranchSelector`, `StorefrontFooter`, `RecentOrderStrip`.

These are **distinct files per vertical** (satisfying the requirement to keep the restaurant
template untouched and allow future divergence) while sharing the neutral catalog rendering
through `StorefrontShell` to avoid four-way duplication of the page.

### Per-vertical copy map

| Vertical   | menuHeading | itemNoun | WhatsApp CTA | hero area label | empty menu title      |
|------------|-------------|----------|--------------|-----------------|-----------------------|
| restaurant | Menu        | dish     | yes          | Dine-in / Table | Menu coming soon      |
| retail     | Shop        | product  | no           | Visit / Delivery| Catalog coming soon   |
| pharmacy   | Shop        | item     | no           | Pharmacy        | Catalog coming soon   |
| timber     | Yard        | item     | no           | Yard            | Yard list coming soon |

Generic states:
- "Restaurant not found" → "{tenant.name} not found" (generic, used by all).
- "This restaurant is getting ready" → "{tenant.name} is getting ready. Check back soon!"
- "Menu coming soon" → per `emptyMenuTitle` from the map above.

The `StorefrontMenu` heading ("Menu") and `Hero` area label read from `config` so the
catalog section re-skins per trade without touching the catalog data.

## Error handling
- Invalid `vertical` at registration → rejected with a clear error (same pattern as the
  existing slug validation).
- Unknown/missing `vertical` on a tenant (defensive) → fall back to `restaurant` template.

## Testing
- `src/server/tenancy/schema.test.ts` (or a new verticals test): enum values and default.
- `src/server/onboarding/service.test.ts`: `registerTenant` persists the provided vertical;
  invalid vertical is rejected.
- Storefront: a test (extend existing storefront test harness) that a tenant with
  `vertical: "retail"` renders the retail template — asserts accent presence, "Shop"/"Catalog"
  heading, and absence of the WhatsApp CTA; and that a `restaurant` tenant still renders the
  original experience.

## Migration & seed impact
- Migration adds `vertical` defaulting to `restaurant`; existing rows unaffected.
- `scripts/seed-showcase.ts` may optionally set a `vertical` per showcase tenant (follow-up,
  not required for this work).

## Follow-ups (not in this work)
- Promote each trade to its own marketing route (copy already lives in `verticals.ts`).
- Build the real vertical domains (barcodes, batch/expiry, dimensions, prescriptions).
- Relabel dashboard / POS / settings per vertical.
