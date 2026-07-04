# Marketing Landing Page — Brand Identity Design

**Date:** 2026-07-05
**Scope:** Marketing homepage only (`/`, non-storefront branch)
**Supersedes:** the *Homepage* section of `2026-06-16-serveos-landing-auth-pages-design.md`
(the dark-navy/orange placeholder). That spec's login/register sections remain in
force and out of scope here — auth pages are a separate future project.
**Depends on:** `2026-07-04-dashboard-brand-identity-design.md` — this project
builds on that branch's brand foundation (tokens, fonts, `LogoMark`/`Wordmark`)
rather than redefining it.

## Problem

`src/app/page.tsx`'s marketing fallback (rendered when `x-surface` isn't
`storefront`) is still the original placeholder: generic dark-navy/orange
inline styles, system fonts, a 3-feature grid, and copy that doesn't reflect
the real ServeOS brand identity (`Serve OS Brand Identity Concepts/`) or lead
with the product's actual entry point for restaurants — getting their menu
online and taking orders.

## Goal

Rebuild the marketing homepage using the ServeOS brand system (warm ink/cream/
coral/teal palette, Bricolage Grotesque + Space Grotesk + JetBrains Mono,
triangle node mark) and the animated dark hero concept
(`ServeOS Hero.dc.html`) as the centerpiece, with copy that leads with online
menu + ordering (QR, WhatsApp, web) and positions POS/inventory/analytics as
supporting capabilities.

## Non-goals

- Login/register page styling (separate future project; unchanged here).
- Any page linked from nav that doesn't exist yet (Pricing, Docs, Customers) —
  nav only links to what's real.
- Fabricated trust-stat numbers (venue counts, trial length) — the concept's
  "Live in 2,400+ venues · 14-day trial" line is dropped; no unverified claims.
- Storefront, admin, dashboard surfaces — untouched.
- Any change to `src/proxy.ts`, middleware, or server/db code — purely
  presentational, same constraint as the dashboard brand project.

## 1. Architecture

Work happens on the `dashboard-brand-identity` branch/worktree, reusing its
brand foundation as-is: `LogoMark`, `Wordmark`, `font-display`/`font-sans`/
`font-mono` utilities, `eyebrow` utility, and the `--primary`/`--background`/
`--foreground`/`--ink` tokens from `globals.css`. No new design tokens, no new
dependencies.

Only the marketing (`else`) branch of `src/app/page.tsx` changes. The
`surface === "storefront"` branch, `layout.tsx`'s surface/font logic, and all
`src/server/*` code are untouched.

### New files

```text
src/app/_components/marketing/Header.tsx      logo + in-page anchor nav + auth links
src/app/_components/marketing/Hero.tsx        animated dark hero
src/app/_components/marketing/Features.tsx    6-card feature grid
src/app/_components/marketing/HowItWorks.tsx  3-step explainer
src/app/_components/marketing/CtaBand.tsx     closing CTA band
src/app/_components/marketing/Footer.tsx      logo + copyright
src/components/brand/FeatureIcon.tsx          6 icon <symbol> defs + <use> wrapper
```

`src/app/page.tsx`'s marketing branch becomes a thin composition of these six
section components (mirrors how the dashboard shell composes `Sidebar`/
`Topbar`/`PageHeader`).

## 2. Page structure & content

### Header

Sticky, transparent over the hero (solidifies to `bg-card` with a hairline
border on scroll — CSS-only via a scroll-linked class is out of scope; use a
simple semi-transparent dark bg that reads fine over the hero throughout).
Left: `LogoMark` (coral) + wordmark. Center/right: anchor links `Features`
(`#features`), `How it works` (`#how-it-works`). Right: "Sign in" (text link,
`/login`) and "Get Started" (coral button, `/register`). Below `md`: collapses
to logo + "Get Started" only (anchor links and Sign in drop into the hidden
state — no hamburger menu needed for a page this short).

### Hero (`#hero`, dark canvas `#17100B`)

Ported from `ServeOS Hero.dc.html`'s Frame A, built with CSS (no exported
images):

- Teal pill badge: **"QR menu · WhatsApp · Web ordering"**, `JetBrains Mono`,
  uppercase, `#5EEBDD` on `rgba(45,212,196,.12)` with a pulsing dot.
- H1 (`font-display`, 800, fluid `clamp(2.5rem, 6vw, 6rem)`, line-height 0.98):
  **"Your menu, online. Orders, everywhere."** — last two words in coral
  `#FF7A54`.
- Subhead (`font-sans`, ~24px desktop / 18px mobile, `max-width: 40ch`):
  "Customers order by scanning a table QR, messaging WhatsApp, or your own
  ordering page — no app to install. It all lands in one dashboard, synced
  with your POS and stock."
- Two CTAs: coral "Get Started →" (`/register`), outlined "Sign in"
  (`/login`).
- Trust line (no fabricated numbers): "No hardware lock-in · English, Spanish,
  Arabic".
- Background: coral + teal radial-gradient glows (`@keyframes drift1/2/3`),
  dashed SVG data-flow paths (`@keyframes dash`), pulsing circle nodes
  (`@keyframes pulse`), faint floating `LogoMark` echoes (`@keyframes
  floaty`) — geometry and timing values taken directly from the concept file.
  Wrapped in `@media (prefers-reduced-motion: reduce)`: all `animation`
  properties removed, glows/lines render static in their base position.
  Decorative SVG/divs get `aria-hidden="true"`.

### Features (`#features`, light `bg-background`)

Eyebrow: "What you get". Section heading: "Everything your restaurant needs to
take orders online." 3×2 card grid (2×3 on tablet, 1-col on mobile), ordering
capabilities first, operations capabilities second:

1. **QR Menu & Ordering** — "Every table gets a menu customers can browse and
   order from in seconds." (`ic-qr`, coral)
2. **WhatsApp Ordering** — "No app required — customers order straight from a
   chat they already have open." (`ic-chat`, coral)
3. **Table Reservations** — "Take bookings without a phone tied up all
   service." (`ic-table`, coral)
4. **Point of Sale** — "One system for online orders and in-house sales —
   nothing to reconcile by hand." (`ic-pos`, coral)
5. **Inventory Control** — "Stock updates as orders come in, so you know
   what's running low." (`ic-inventory`, teal)
6. **Live Analytics** — "See what's selling, when, and where — as it
   happens." (`ic-analytics`, teal)

Cards: `bg-card`, `rounded-xl`, `border`, icon in a coral/teal-tinted circle
(`bg-primary/10 text-primary` or teal equivalent), `font-display` title,
muted-foreground description — same card language as the dashboard's
`EmptyState`/`Card` usage.

### How it works (`#how-it-works`, light)

Eyebrow: "How it works". 3 steps, `JetBrains Mono` `01`/`02`/`03` numerals in
coral:

1. **Build your menu** — categories, products, photos, EN/AR.
2. **Customers order** — QR at the table, WhatsApp, or your ordering link.
3. **It all lands in your dashboard** — orders, POS, and stock update
   together.

### Closing CTA band

Coral-tinted band (`bg-primary/5` or similar warm tint, not full solid coral,
to stay in the "restrained" brand register): "Get your menu online today."
Single coral "Get Started" button.

### Footer

`LogoMark` + wordmark (small), "© 2026 ServeOS" — no Privacy/Terms links
(those pages don't exist; the old spec's `href="#"` placeholders are dropped
rather than carried forward).

## 3. Technical notes

- **Icons:** one inline `<svg width="0" height="0">` holding all 6 `<symbol>`
  defs (paths copied from `ServeOS Feature Icons.dc.html`), rendered once in
  `FeatureIcon`'s module scope or at the top of `Features.tsx`; each card
  references it via `<svg><use href="#ic-qr"/></svg>` with `color` set by a
  Tailwind text-color class (`currentColor` fill/stroke in the source paths).
- **Responsive:** hero H1 via `clamp()`; feature grid `grid-cols-1
  md:grid-cols-2 lg:grid-cols-3`; header nav links hidden `<md`.
- **No new dependencies** — Tailwind v4 utilities + inline SVG only, consistent
  with the dashboard brand work.
- **Accessibility:** one `h1` (hero), `h2` per section; decorative hero
  background elements `aria-hidden`; hero text contrast checked against the
  existing dashboard-spec dark palette (coral/cream on `#17100B` already
  verified there); focus-visible states on all links/buttons (inherit from
  shadcn `Button`/default browser focus ring, not suppressed).

## Testing & rollout

- `npx tsc --noEmit` and `npx next build` (mandatory per `AGENTS.md` — this is
  a non-standard Next.js build).
- Manual pass at `localhost:3000` (bare host = marketing surface): visual
  check against the brand concept, both OS color schemes, `prefers-reduced-
  motion` toggled on, and a mobile-width (375px) check.
- No existing tests target the marketing homepage; none are expected to break
  since the storefront branch of `page.tsx` is untouched.

## Risks

- **Motion cost:** several concurrent CSS animations in the hero; mitigated by
  keeping them to `transform`/`opacity` only (already true in the concept
  source) and disabling entirely under reduced-motion.
- **Font load:** hero headline is large and above the fold — `next/font`'s
  `display: "swap"` (already configured in `fonts.ts`) avoids invisible text
  during load.
