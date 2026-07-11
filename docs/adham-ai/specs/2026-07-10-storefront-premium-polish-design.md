# Storefront Premium Polish — Design

**Date:** 2026-07-10
**Status:** Approved (design) — pending implementation plan
**Scope:** Visual/UX elevation of the entire customer storefront flow — menu/home, product sheet, cart drawer, checkout, order tracking — to a production-grade "Premium Hybrid" direction, backed by small honest data-model additions and a rich Roma demo seed.
**Depends on:** `2026-07-07-storefront-checkout-experience-design.md` (the functional flow this polishes) and the brand identity in `src/app/globals.css` + `src/app/fonts.ts`.

## Problem

The customer storefront is functionally complete and brand-token-consistent, but visually plain — it reads as a wireframe, not a real restaurant's ordering experience. Menu cards are small and text-heavy, the hero is a thin band, there is no visual rhythm or hierarchy, and the flow (product sheet → cart → checkout → tracking) is utilitarian. The product is QR/link-first in a delivery-heavy market (EG/SA), where the storefront IS the brand's first impression and directly drives conversion. It needs to feel premium and appetite-forward while staying fast and familiar.

A second, compounding problem: the demo tenant (Roma) has almost no content — one branch, a handful of bare products, no imagery — so there is nothing to design great cards and sections against.

## Goal

Elevate every customer-facing surface to the approved **Premium Hybrid (Direction C)** language — cinematic hero, sticky glass category nav, featured-item rhythm, image-forward-but-breathable cards, persistent cart CTA, cohesive product sheet / cart / checkout / tracking — using the existing brand identity (cream `#fbf7f2`, coral `#f0522b`, ink `#1a0f0a`, Bricolage Grotesque display + Space Grotesk body, `0.75rem` radius). Back the UI with **truthful data only**: add a few cheap real fields, derive badges from real signals, and seed Roma with realistic content. No fabricated ratings on a live storefront.

## Non-goals

- **Ratings/reviews system.** No star ratings anywhere until a real reviews feature exists. The hero leads with cuisine · area · open-state · ETA instead.
- **Arabic/RTL restructuring.** Own upcoming spec; keep the existing dual EN/AR display pattern.
- **Payments, custom domains, dine-in/POS.** Out of scope.
- **Image CDN / next-image optimization.** Deferred fast-follow. This pass uses raw `<img>` (as today) with `loading="lazy"` + explicit aspect ratios to prevent layout shift; it does not introduce an optimization pipeline.
- **Dashboard restyle.** Restaurant-side UI is untouched except where a new field needs a control (see §2).
- **Functional/logic changes** to ordering, scheduling, cancel, branch flow, currency — those shipped in the prior spec and are frozen here except for visual markup. Accessible names/text the e2e suite asserts (`Add —`, `View cart`, `Checkout`, `Cancel order`, `/Scheduled for/`, `pending`, `/cancelled/i`, placeholders `Name`/`Phone`, heading `/Checkout/`) MUST be preserved.
- **New runtime npm dependencies.** Motion uses CSS transitions; icons use the already-present `lucide-react`.

## Direction: Premium Hybrid (C)

Chosen over "Warm Editorial" (too sparse for a delivery menu) and "Appetite-First Delivery" (fast but not premium enough). C fuses them: editorial warmth in the hero and section rhythm, delivery-app usability in the sticky nav, dense-enough cards, and an always-reachable cart. Every surface inherits this language so the flow feels like one designed system.

## 1. Design language (shared primitives)

Add a small, reusable layer to `src/app/globals.css` (`@theme` tokens + a few `@utility`/base rules) so surfaces compose from one vocabulary rather than ad-hoc styles:

- **Elevation:** `--shadow-card` (rest) and `--shadow-card-hover` (lifted) — soft, warm-tinted (`rgba(26,15,10,.…)`), not gray. A `.card-lift` utility applies rest shadow + `transition` + hover translate/shadow.
- **Imagery:** a `.sf-img` treatment — `object-fit:cover`, rounded to token radius, `1px` inset border at `--border`, `loading="lazy"`, and explicit `width`/`height` or `aspect-ratio` on every storefront `<img>` to eliminate CLS.
- **Trust chips:** `.sf-chip` — the translucent/blurred pill used in the hero bar and a solid variant for light surfaces.
- **Section header:** a `SectionHeader` component (eyebrow mono label + Bricolage title + optional count/subtitle), reused across menu sections and surface headers.
- **Badges:** `.sf-badge` (coral) + `.sf-badge-soft` (accent) for "Popular"/"New"/"Featured".
- **Motion:** all transitions gated behind `@media (prefers-reduced-motion: no-preference)`; press/active feedback on buttons; sheet slide+fade already provided by the `Sheet` primitive.

Coral remains the single accent (CTAs, active nav, price, badges). No new fonts. No gradient-heavy treatments — depth via shadow and spacing.

## 2. Data model additions + Roma seed

One additive migration (`drizzle-kit generate`; nullable/defaulted columns only, same procedure as prior specs):

- **`tenants`:** `tagline text` (nullable) and `cuisine text` (nullable). Shown in the hero ("Authentic Italian · Maadi"). A dashboard settings control for these is added (small, in the existing brand/settings form) so it is real and editable — not seed-only.
- **`products`:** `isFeatured boolean not null default false`. Drives the one large featured card per section. A toggle is added to the existing product editor.
- **Derived, NO new columns:**
  - **"New" badge:** `products.createdAt` within the last 14 days.
  - **"Popular" badge:** the top 5 products per tenant by lifetime `orderItems` quantity, counting only products with ≥1 order (a `getPopularProductIds(tenantId): Promise<Set<string>>` query used at menu render; empty/zero-order tenants show no Popular badges).
  - **Delivery ETA / min-order:** existing `deliveryAreas.etaMinutes` / `minOrderAmount`.
  - **Open-state / closes-at:** existing `getBranchOpenState` (tenant timezone).
  - **Cuisine/area in hero:** new `cuisine` + branch address/area.

**Roma seed rewrite** (`scripts/seed.ts`, idempotent) — realistic content to design against:
- `tenant`: tagline "Authentic Italian, wood-fired" + cuisine "Italian", cover image, logo.
- ~6 categories with images: Pizza, Pasta, Salads, Starters, Dolci, Drinks.
- ~30 published products across them, each with EN/AR names, a real description, an Unsplash food `imageUrl`, sensible EGP prices; 4–6 marked `isFeatured` (roughly one per section); a spread of `createdAt` so some read as "New".
- Modifier groups where natural (Pizza size S/M/L, Extras; Pasta add-ons; Drinks size).
- 2–3 promo banners with images.
- Delivery areas with `etaMinutes` (already seeded — keep/extend).
- A handful of seeded orders skewed so "Popular" has signal (a few products with higher order counts).

Images are remote Unsplash URLs in the seed (demo tenant); real tenants upload their own via the existing media-upload path. Seed image URLs are pinned (stable photo IDs + sizing params).

## 3. Surfaces

All storefront components live in `src/app/_components/storefront/`. Each is restyled to the shared language; logic/props are preserved unless noted.

### 3.1 Menu / home (`src/app/page.tsx` storefront branch, `Hero`, `CategoryNav`, `StorefrontMenu`, `ProductCard`)
- **Hero:** full-bleed cover image with a bottom ink-gradient scrim, logo badge overlapping the lower edge, tenant name in Bricolage, `tagline`/`cuisine · area` line, and a truthful chip row (open-state + closes-at, ETA range from areas, min-order). Falls back gracefully when cover/logo/tagline absent.
- **Category nav:** sticky, glassy (`backdrop-blur` + translucent cream), horizontal scroll; builds on the existing anchor navigation by adding scroll-spy — the pill for the section currently in view is highlighted (ink/coral active state) and clicking a pill smooth-scrolls to that section.
- **Sections:** each category gets a `SectionHeader` (eyebrow + Bricolage title + item count). Within a section: the `isFeatured` product renders as one large cinematic card (image + ink scrim + name/desc/price); the rest render as refined cards (image-forward, name, short description, price, add affordance) with Popular/New badges where earned.
- **Open-state / paused / branch-pick / recent-order strip / footer:** keep the functional behavior from the prior spec, restyled to match (banner as a warm inline bar; footer as a proper multi-column footer with hours/contact/WhatsApp).
- **Persistent cart CTA:** the existing `CartBar`, restyled as a floating rounded coral bar with item count + total + "View cart".

### 3.2 Product sheet (`ProductSheet`)
Larger hero image at the top of the sheet; Bricolage product name + description; modifier groups with clear group headers, required/optional hints, and selected-state option rows (coral ring/fill); quantity stepper; sticky footer "Add — EGP …" (substring preserved) that updates live.

### 3.3 Cart drawer (`CartDrawer`)
Refined line rows (image thumbnail, name, modifier summary, stepper, line total in currency), clear subtotal, pre-order note when applicable, prominent "Checkout →" (substring preserved). Empty state with a friendly prompt.

### 3.4 Checkout (`src/app/checkout/*`)
Restyle the existing branded form to the shared language: segmented fulfillment + ASAP/Schedule toggles, slot pills with clear selected state, grouped contact/address fields using the `ui` primitives, and a summary card with real hierarchy (items, subtotal, VAT, delivery, total). Branch-guard, min-order warning, prefill, stale-slot logic all preserved. Heading `/Checkout/` and placeholders `Name`/`Phone` preserved.

### 3.5 Tracking (`src/app/order/[token]/*`)
A hero-lite header (tenant name + order number + placed/scheduled time), the status timeline elevated to the shared language (kept 5s poll + terminal stops), the receipt and fulfillment recap as clean cards, Cancel-order affordance + WhatsApp CTA preserved. `/Scheduled for/`, `pending`, `Cancel order`, `/cancelled/i` strings preserved.

## 4. Motion & performance

- Transitions only (no JS animation libs), all under `prefers-reduced-motion: no-preference`: card hover-lift, active/press feedback, sticky-nav background transition, sheet slide/fade (from `Sheet`).
- Every storefront `<img>` gets `loading="lazy"` and an explicit aspect ratio / dimensions.
- No blocking web fonts beyond those already loaded via `next/font`.

## 5. Testing & verification

- **Vitest:** new pure/query logic gets tests — `getPopularProductIds` (order-count ranking, tenant isolation, zero-orders → empty), the "New" predicate (14-day boundary), and any seed helper that's unit-testable. Existing suites stay green.
- **No component unit tests** (repo convention) — UI verified by `tsc --noEmit`, `npm run build`, Playwright, and manual pass.
- **Playwright:** all existing specs (`ordering`, `menu`, `responsive`, `scheduling`, plus dashboard) must stay green; accessible names/text are preserved by contract (see Non-goals). Any spec that asserts old plain markup is updated to the new markup without weakening the assertion.
- **Manual pass** on the live Roma storefront (local dev server): hero, sticky nav, featured + badges, product sheet, cart, checkout (ASAP + schedule), tracking, cancel — across a phone-width and desktop viewport, plus `prefers-reduced-motion`.
- Migration applied to local DB via `db:migrate` / `db:migrate:test`; production migration is a deploy-time step (flagged, like the prior spec).

## 6. Decision log

| Decision | Choice |
| --- | --- |
| Visual direction | C — Premium Hybrid (over A Warm Editorial / B Appetite-First) |
| Data truthfulness | Truthful-only + cheap real fields; derive badges from real signals; NO fabricated ratings |
| New fields | tenant `tagline`, `cuisine`; product `isFeatured` (all dashboard-editable) |
| Badges | "New" from createdAt (<14d); "Popular" from real order-item counts |
| Ratings | Dropped until a real reviews feature exists |
| Scope | All customer surfaces (menu, product sheet, cart, checkout, tracking) in one cohesive pass |
| Roma content | Full seed rewrite: ~6 categories, ~30 imaged products, modifiers, banners, popular-signal orders |
| Images | Raw `<img>` + lazy + aspect ratio; remote Unsplash in seed; CDN optimization deferred |
| Motion | CSS transitions only, `prefers-reduced-motion`-gated |
| Frozen | All functional/logic behavior + e2e-asserted accessible names/text |
