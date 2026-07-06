# ServeOS Responsive Across All Surfaces — Design

**Date:** 2026-07-06
**Status:** Approved (design) — pending implementation
**Scope:** All web surfaces — dashboard (owners), storefront (customers), checkout/order, admin panel

## Problem

Logging into the owner dashboard on a phone shows **no navigation at all**. The dashboard
sidebar is `hidden md:flex` ([Sidebar.tsx](../../../src/components/dashboard/Sidebar.tsx)), so
below the `md` breakpoint (768px) it disappears entirely, and nothing replaces it — the
[Topbar](../../../src/components/dashboard/Topbar.tsx) only carries notifications and the user
menu. An owner on mobile can reach `/dashboard` but cannot navigate to Menu, Orders, Settings,
etc. More broadly, the product has never had a deliberate responsiveness pass across surfaces.

## Goal

Make every surface usable on all screen sizes down to a **360px-wide** phone, with **no
horizontal page (body) scroll**. The centerpiece is a mobile navigation for the dashboard;
the rest is a targeted audit-and-fix of concrete breakages, not a redesign.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Scope | All surfaces: dashboard, storefront, checkout/order, admin |
| Mobile dashboard nav | Hamburger button → slide-out **left drawer** reusing the exact sidebar nav items |
| Drawer primitive | Existing `Sheet` (`src/components/ui/sheet.tsx`, Radix Dialog-based) — no new dependency |
| Nav source of truth | Extract shared `DashboardNav`; desktop `Sidebar` and mobile drawer both render it |
| Table strategy | Tables already scroll (`Table` wraps in `overflow-x-auto`) → keep as scroll-safe baseline; **upgrade Orders + Menu to stacked cards below `md`** |
| Breakpoints | Tailwind defaults, mobile-first; min target 360px |
| Verification | Playwright screenshots at 375 / 768 / 1280 + manual drawer/nav pass |

## Non-goals (this pass)

- Redesigning any page layout or visual style.
- Converting **every** table to stacked cards — only Orders and Menu (the two owners use on a phone).
- A bottom tab bar or a second navigation system.
- POS desktop app (not built yet).
- New breakpoints/tokens beyond Tailwind defaults.
- Offline/PWA behavior changes.

## Architecture

### Dashboard shell (the core fix)

**`DashboardNav` (new, shared)** — renders the nav: brand header (logo + wordmark), restaurant
name, and the item list with active-route highlighting (`usePathname`). Depends only on
`NavItem[]` + current pathname. Single source of truth for nav markup.

- **How used:** rendered by both the desktop sidebar and the mobile drawer.
- **What it depends on:** `nav-items`, `usePathname`, `LogoMark`.

**Desktop `Sidebar`** — becomes a thin `<aside className="hidden md:flex …">` wrapper around
`DashboardNav`. Visual output unchanged from today.

**`MobileNav` (new, client)** — a hamburger `Button` (`aria-label="Open menu"`) that opens
`<Sheet side="left">` containing `DashboardNav` plus a Sign-out action. Behavior:

- Closes on route change (effect on `usePathname`).
- Closes on backdrop click and Esc; focus trap — all provided by `Sheet`/Radix Dialog.
- Rendered `md:hidden`.

**`Topbar`** — add the hamburger on the **left** (`md:hidden`) and show the ServeOS wordmark +
restaurant name on mobile (the sidebar header is hidden there). Notifications + user menu remain
right-aligned. On `md+`, the hamburger and mobile brand are hidden and the bar is unchanged.

**`layout.tsx`** — pass `items` and `restaurantName` to the mobile nav (via Topbar or directly).
Desktop structure untouched; the drawer is purely additive below `md`.

### Dashboard content & tables

- Baseline is already safe: `Table` renders inside `<div class="relative w-full overflow-x-auto">`,
  so wide tables scroll rather than breaking the page.
- **Orders** ([/dashboard/orders](../../../src/app/dashboard/orders)) and **Menu**
  ([/dashboard/menu/page.tsx](../../../src/app/dashboard/menu/page.tsx)): render a **stacked-card
  list below `md`** (`md:hidden`) alongside the existing table (`hidden md:block`), from the same
  data — no duplicate data fetching, just a second presentation.
- Global content polish: main padding `p-6` → `p-4 md:p-6`; ensure `PageHeader` action buttons
  wrap rather than overflow on narrow screens.

### Storefront / checkout / order / admin audit

Mobile-first review at 375px; fix concrete breakages only:

- **Storefront** (`Hero`, `CategoryNav`, `ProductCard` grid, `CartBar`, `ProductSheet`): already
  uses responsive classes — verify hero text scaling, grid columns, sticky `CartBar` not
  overlapping content, and tap targets ≥44px.
- **Checkout / order**: form and order summary stack cleanly; primary buttons thumb-reachable.
- **Admin** (login + panel): usable at 375px. Lower priority (single operator), but in scope.

## Data flow

No data-layer changes. All work is presentational (layout, CSS/Tailwind classes, one new
client component + one extracted component). Stacked-card table variants read the same
server-fetched data already passed to each page.

## Error handling / edge cases

- Drawer must not remain open after navigating (route-change close effect).
- No horizontal body scroll at 360px on any page (verify explicitly).
- Active-route highlighting identical in drawer and desktop sidebar (shared component guarantees it).
- Keyboard + screen-reader: trigger labelled; Sheet provides focus trap and Esc-to-close.

## Testing

- **Playwright screenshots** at 375 / 768 / 1280 for: dashboard Menu, dashboard Orders,
  storefront menu, checkout, admin.
- **Manual**: open drawer → navigate → drawer auto-closes → correct item active → Sign out works.
- **Assertion**: no horizontal scroll on `document.body` at 360px width across audited pages.

## Files (anticipated)

- `src/components/dashboard/DashboardNav.tsx` (new)
- `src/components/dashboard/MobileNav.tsx` (new)
- `src/components/dashboard/Sidebar.tsx` (refactor to wrap `DashboardNav`)
- `src/components/dashboard/Topbar.tsx` (add hamburger + mobile brand)
- `src/app/dashboard/layout.tsx` (wire mobile nav)
- `src/app/dashboard/menu/page.tsx`, `src/app/dashboard/orders/*` (stacked-card mobile variants)
- Spot fixes in storefront/checkout/order/admin as found during the audit
