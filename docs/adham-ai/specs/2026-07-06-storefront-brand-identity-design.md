# Storefront Brand Identity — Design

**Date:** 2026-07-06
**Status:** Approved (design) — pending implementation plan
**Scope:** Customer storefront menu/browse page only (`x-surface === "storefront"` branch of `src/app/page.tsx`, plus `StorefrontMenu.tsx` and its children)
**Depends on:** `2026-07-04-dashboard-brand-identity-design.md` and `2026-07-05-marketing-landing-page-design.md` — reuses their brand foundation (tokens, fonts, `LogoMark`) rather than redefining it.

## Problem

The customer-facing storefront — the page a diner actually lands on from a
published menu link or QR code — is still the original unstyled placeholder:
raw inline styles, system fonts, a plain product grid, and a native
`<select>` for branch switching. Meanwhile the dashboard and marketing
homepage have both been rebuilt on the real ServeOS brand identity (warm
ink/cream/coral palette, Bricolage Grotesque + Space Grotesk + JetBrains
Mono, triangle node mark). Both of those specs explicitly named the
storefront as the next surface in the rollout.

## Goal

Bring the ServeOS brand system to the storefront and elevate the ordering
experience to a premium, "alive" feel comparable to established food-delivery
apps (Talabat/Careem/Deliveroo-tier polish): a full-bleed restaurant cover
photo hero, sticky category navigation, image-forward product cards with a
detail sheet for configuring modifiers, and a persistent cart bar.

## Non-goals

- Checkout page (`/checkout`) and order-tracking page (`/order/[token]`) —
  separate future pass, once this visual language is locked in.
- Login/register/auth pages — unchanged.
- Any change to cart, checkout, or ordering logic/state (`cart.ts`,
  server actions, schema for orders/menu) — purely presentational, same
  constraint as the dashboard and marketing rebrands.
- Arabic UI translation or RTL restructuring — the existing dual EN/AR
  product/category name display is kept as-is, just restyled.
- A media upload widget — the new cover photo field is a plain URL input,
  matching how `logoUrl` and banner images already work. No surface in the
  app currently has an upload UI wired to the existing `media-upload` API;
  this project doesn't introduce the first one.
- Any new animation/motion dependency — CSS-only transitions.
- Custom illustration/icon set beyond what the dashboard project already
  established (lucide icons, `EmptyState`'s `LogoMark`-based treatment).

## 1. Data model addition

One new nullable column on `tenants`:

```ts
coverImageUrl: text("cover_image_url"),
```

Added via `db:generate` + a reviewed migration, following the exact shape of
the existing `logoUrl` column. `UpdateTenantProfileInput` (in
`src/server/tenancy/service.ts`) picks up `coverImageUrl`. The Business
Profile settings page (`src/app/dashboard/settings/profile/page.tsx`) gets a
"Cover photo URL" text input directly under "Logo URL", identical pattern
(plain URL `<Input>`, no upload widget).

## 2. New storefront components

New directory `src/app/_components/storefront/`:

- **`Hero.tsx`** — full-bleed cover photo (`object-cover`, viewport width)
  with a dark gradient overlay (transparent → `rgba(23,16,11,.85)` bottom),
  logo + restaurant name in `font-display` sitting on the gradient. When
  `coverImageUrl` is unset, falls back to a gradient built from the tenant's
  `primaryColor` (same slot, no photo) so restaurants who haven't set a cover
  yet still get an elevated hero, not a broken image.
- **`CategoryNav.tsx`** — sticky pill row directly below the hero
  (`position: sticky`, `top: 0`, backdrop-blur on the card background).
  Active category tracked via `IntersectionObserver` against each category
  section; active pill = coral background/white text, inactive = cream with
  a hairline border. Horizontally scrollable, no visible scrollbar, on
  narrow viewports.
- **`ProductCard.tsx`** — photo (`aspect-[4/3]`, `object-cover`, rounded per
  brand radius), name (`font-sans` semibold), price (`font-display` bold),
  coral "Add" affordance. Hover: subtle lift + shadow. No inline modifiers.
  Tapping/clicking anywhere on the card opens `ProductSheet`.
- **`ProductSheet.tsx`** — built on a new `components/ui/sheet.tsx` (standard
  shadcn Radix-`Dialog` wrapper; `radix-ui` is already a dependency, no new
  package). Renders as a bottom sheet on mobile (slides up, rounded top
  corners) and a centered modal on desktop. Contents: photo, name,
  description, modifier groups (reusing the existing selection logic
  currently inline in `StorefrontMenu.tsx`'s `ProductCard`), quantity
  stepper, and a full-width "Add — `{price}`" button.
- **`CartBar.tsx`** — fixed to the bottom of the viewport, appears (fade/slide
  in) once the cart has 1+ line items: "View cart · N items · `{subtotal}` →".
  Tapping opens the existing cart drawer (restyled, logic untouched).

## 3. Restyled existing pieces

- **`StorefrontMenu.tsx`** — becomes a thin composition of `CategoryNav` +
  `ProductCard` + `ProductSheet` + `CartBar` + the existing `CartDrawer`
  (restyled to brand tokens/fonts, same markup structure/logic). All cart
  state (`loadCart`, `addLine`, `removeLine`, `cartSubtotal`, the
  `serveos-cart-changed` event) is untouched.
- **`BranchSelector.tsx`** — swaps the native `<select>` for the existing
  `components/ui/select.tsx` (shadcn `Select`), same props/behavior.
- **Banners strip** (in `page.tsx`) — same horizontal-scroll structure, brand
  radius and spacing applied.
- **Empty/error states** — "Restaurant not found", "getting ready", "menu
  coming soon" reuse the existing `EmptyState` component
  (`src/components/dashboard/EmptyState.tsx`) rather than a new one — it only
  depends on the shared `LogoMark`, no dashboard-specific coupling.

## 4. Visual system

No new tokens, no new fonts, no new dependencies — entirely the system
`globals.css` and `fonts.ts` already define and `layout.tsx` already loads
for every surface (font variables are global, just unused by the storefront
until now):

- Colors: `--primary` (coral) for actions/active states, `--background`
  (warm cream) / `--card` for surfaces, `--ink` for headings, `--muted-foreground`
  for secondary text.
- Type: Bricolage Grotesque (`font-display`) for restaurant name, section
  headings, and prices; Space Grotesk (`font-sans`, default) for body/product
  names; JetBrains Mono `eyebrow` utility for the category pill labels in
  `CategoryNav`.
- Radius: brand `--radius` (~12px) on cards, sheet corners, pills.
- Motion: plain CSS transitions — hover lift on cards, slide-in for the
  sheet and cart bar. No animation library added.

## Testing & rollout

- Typecheck + `next build` after the schema/migration change (AGENTS.md:
  this is a non-standard Next.js build — read its docs before assuming
  defaults) and again after the component work.
- Existing vitest suite stays green — cart logic, tenancy service, and
  routing tests are untouched by this pass.
- Manual pass against a seeded tenant (`roma`) on `roma.serveos.tech`,
  covering: hero with and without a cover photo set, category nav scroll
  tracking, product sheet open/configure/add for both single-select and
  multi-select modifier groups, cart bar appearance/update, branch selector,
  and all three empty/error states.
- Ship as one reviewable unit (schema + settings field + storefront
  components together) — the pieces are small and interdependent enough
  that splitting further would just add coordination overhead.
