# ServeOS Dashboard Brand Identity — Design

**Date:** 2026-07-04
**Status:** Approved (design) — pending implementation plan
**Scope:** Restaurant dashboard surface only (`/dashboard/*`)
**Supersedes:** the *visual direction* row of the 2026-06-29 dashboard redesign
spec (interim orange `#f97316` on slate). All functional/UX decisions of that
spec remain in force; this spec replaces its look with the real ServeOS brand
identity and covers completing the remaining page migrations under it.

## Problem

The dashboard foundation, shell, and Home page were built on an interim visual
direction (generic orange on slate grays, system fonts, white background). The
real ServeOS brand identity now exists (`Serve OS Brand Identity Concepts/`):
warm ink + cream + coral palette, Bricolage Grotesque / Space Grotesk /
JetBrains Mono type system, and the triangle node mark. The remaining dashboard
pages (Orders, Menu, Branches, Fulfillment, Banners) are still unstyled legacy
pages. Building them on the interim look would mean styling everything twice.

## Goal

Adopt the brand identity as the single visual system for the dashboard, then
complete all remaining page redesigns under it. The dashboard is the first
surface of a broader rollout (marketing/auth, storefront, admin follow as
separate projects).

## Decisions (locked)

| Decision | Choice |
|---|---|
| First surface | Restaurant dashboard (`/dashboard/*`) |
| Dashboard treatment | **Dark ink sidebar (`#17100B`) + warm cream content area** — per the Sidebar Branding concept's in-context mockup |
| Implementation approach | **Token-level rebrand**: remap shadcn semantic CSS variables; no overlay classes, one source of truth |
| Concept fidelity | Tokens + fonts + logo, plus JetBrains Mono eyebrow labels and concept-style empty states. Custom UI icon set deferred (lucide at 1.5px stroke for now) |
| Scope | Rebrand foundation + reskin shell/Home + migrate **all remaining dashboard pages** |
| Language | Unchanged from 2026-06-29 spec: English-only chrome, EN+AR content fields |

## Non-goals (later passes)

- Marketing (`/`), auth (login/register), customer storefront, platform admin.
- OG image, email header, QR menu template, social kit assets.
- Custom UI icon set from the concepts.
- Arabic UI translation / full RTL dashboard.
- Any backend, schema, server-action, or service changes — purely presentational.

## 1. Brand foundation

### Design tokens (`globals.css`)

Replace the interim slate/orange values; shadcn components pick the brand up
automatically.

- **Neutrals (warm)** — brand paper/100/500/700 scale:
  - App background (paper): `#FBF7F2`
  - Cards / elevated surfaces: `#FFFDFB`
  - Borders / dividers: `rgba(26,15,10,.09)`
  - Muted text: `#948676`
  - Body text: `#3A332C`
  - Headings / ink: `#1A0F0A`
- **Primary:** coral `#F0522B`, white foreground; hover toward `#D23F1C`.
- **Sidebar token group** (`--sidebar-*`): background `#17100B`, foreground
  cream, active item `rgba(240,82,43,.16)` tint with coral text/icon, border
  `rgba(255,255,255,.14)`.
- **Semantic order-status colors** (used everywhere status appears):
  pending `#E8A33D` (amber) · confirmed `#2E6BFF` (blue) · preparing `#2DD4C4`
  (teal) · ready `#38D08C` (green) · completed `#948676` (warm gray) ·
  cancelled/rejected `#CE2C2C` (red). Teal doubles as the brand's data/AI/charts
  accent.
- **Radius:** `--radius` ≈ 12px so shadcn lg/xl land in the brand's 16–22px
  card zone.

### Typography (`next/font/google`, self-hosted at build)

- **Bricolage Grotesque** 600/700/800 — H1–H3, big numbers (order counts,
  totals), wordmark.
- **Space Grotesk** 400/500/700 — default UI/body font.
- **JetBrains Mono** 400/500 — reusable `eyebrow` utility (11px, uppercase,
  `.16em` tracking) for card section labels and data values (order codes).
- **IBM Plex Sans Arabic** — fallback in the stack so Arabic content values
  render properly; no UI translation.
- Subset to the listed weights, Latin (+Arabic for Plex) only.

### Logo & assets

- `<LogoMark />` — triangle node mark as inline SVG, `currentColor` (works
  coral-on-dark and ink-on-cream).
- `<Wordmark />` — mark + "Serve**OS**" with coral "OS".
- `public/` assets: favicon / `icon.svg` (coral mark on ink tile, per Avatar &
  Splash concept) + touch icon.

## 2. Shell reskin

Purely re-skinning — role-gating, drawer collapse, nav model, data loading
(`requireDashboardUser()`) unchanged.

- **Sidebar** (`src/components/dashboard/Sidebar.tsx`) — dark ink:
  coral logo tile + cream wordmark at top, restaurant name beneath in eyebrow
  style; nav items cream at ~70% opacity, hover = subtle white tint, active =
  coral-tint pill with full-coral text/icon; lucide icons 1.5px stroke.
- **Topbar** — stays light: warm white, hairline warm border; breadcrumb in
  Space Grotesk; pending-orders bell with coral badge; user menu unchanged.
- **PageHeader** — Bricolage 700 title, optional eyebrow line above, muted
  description, coral primary action.
- **Home** — reskins via tokens, plus: eyebrow treatment on checklist card,
  today's-snapshot counts as Bricolage big-numbers in semantic status colors,
  coral done-state checkmarks.

## 3. Page migrations

Functional/UX design per page follows the 2026-06-29 spec unchanged (tables,
tabs, dialogs, toasts, state-machine actions). Brand treatment on top:

| Page | Brand treatment |
|---|---|
| Orders list | Semantic-palette status Badges; order codes in JetBrains Mono; coral-underline filter Tabs; "new order" flash = warm coral tint |
| Order detail | Totals/order number as Bricolage big-numbers; cards on warm white with eyebrow section labels; single coral button for next state, secondary states outlined ink |
| Menu | Eyebrow category headers; product Table with warm-toned thumbs; coral published Switch |
| Product / Category forms | Branded form controls; EN left / AR right with IBM Plex Sans Arabic |
| Branches list + detail | Branch cards on warm white, coral accents |
| Fulfillment | Settings Tabs (Hours · Delivery areas · VAT · Accepting orders); accepting-orders toggle gets the "go live" coral treatment |
| Banners | List + form, same system |

**`<EmptyState />`** — one reusable component in the concepts' style: small
ink-outline illustration from the node-mark motif, Bricolage title, muted
description, coral action. Used on every list page.

**Ship order** (each a reviewable, shippable unit):
Foundation rebrand → Shell + Home reskin → Orders → Order detail → Menu →
Product/Category forms → Branches → Fulfillment → Banners.

## 4. States, feedback & error handling

Inherited from the 2026-06-29 spec, now branded:

- Pending submit buttons (spinner + disabled) in coral.
- Sonner toasts on warm white with ink text.
- Skeleton rows in warm gray tint.
- AlertDialog confirms for destructive actions.
- Inline field errors in brand red `#CE2C2C`.
- Dashboard `error.tsx` boundary gets the branded empty-state treatment.

## Testing & rollout

- Typecheck + `next build` immediately after the foundation swap (AGENTS.md
  warns this is a non-standard Next.js build) before any page work.
- Existing vitest suite stays green — work is presentational.
- Extend Playwright with the happy-path flow (login → Orders → advance status)
  once Orders is migrated.
- Manual visual pass per page against the brand concepts.

## Risks

- **Dark-sidebar contrast:** verify WCAG AA. Coral `#F0522B` on `#17100B`
  passes for large/bold text and icons; body-size nav labels use cream, with
  coral reserved for the active state on its tint pill.
- **Font weight:** three families via `next/font`; mitigated by weight/subset
  limits above.
- **Transitional divergence:** marketing/auth keep the old dark + `#f97316`
  look until their own rebrand pass; accepted, they're the next project.
