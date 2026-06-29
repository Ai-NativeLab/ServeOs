# ServeOS Dashboard Frontend Redesign — Design

**Date:** 2026-06-29
**Status:** Approved (design) — pending implementation plan
**Scope:** Restaurant dashboard surface only (`/dashboard/*`)

## Problem

The app works, but the restaurant dashboard has no cohesive UI and no usable
navigation. Every page is a standalone `<main style={{padding:32}}>` with inline
styles, `system-ui`/Arial type, and raw `[edit]` / `[delete]` text links. There
is no shared layout, no sidebar, no breadcrumbs, no feedback on actions — so
there is effectively "no user flow anywhere." This blocks onboarding real
restaurants, who need to set up and run their operation daily.

## Goal & audience

Primary goal: **onboard real restaurants.** The audience is restaurant
owners/managers/staff using the dashboard for setup and daily operations. Success
= the dashboard looks professional and is navigable, and a new restaurant can get
set up and run service without confusion.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Priority surface | Restaurant dashboard (`/dashboard/*`) |
| UI tech | **Tailwind CSS v4 + shadcn/ui** (components copied into repo, we own them) |
| Visual direction | **Light, clean, operator-focused**; orange (`#f97316`) accent on slate neutrals |
| Brand split | Marketing + auth keep their existing dark+orange look; dashboard is light |
| Scope depth | Foundation + shell + **all ~11 dashboard pages** in one cohesive pass |
| Language | **English-only dashboard chrome** (menu content keeps EN+AR fields); components built RTL-friendly, no Arabic translation yet |
| Devices | **Desktop-first, tablet-friendly** (collapsible sidebar); phone usable |
| Strategy | **Approach A** — shell-first, then migrate pages one at a time, extracting components as needed |

## Non-goals (YAGNI / later passes)

- Redesign of marketing (`/`), customer storefront (`/`, `/checkout`, `/order/[token]`), or platform admin (`/admin/*`).
- Full Arabic / RTL dashboard translation.
- Any backend, schema, server-action, or service changes. This work is **presentational**; it reuses all existing server actions and services as-is.

## Architecture

### Foundation (design system)
- Add **Tailwind CSS v4** and initialize **shadcn/ui**: `cn()` helper in
  `src/lib/utils.ts`, primitives under `src/components/ui/`, `components.json`.
  Additive only — does not touch `proxy.ts` surface routing or marketing/auth pages.
- **Design tokens** as CSS variables in `globals.css` (light theme):
  - Primary: orange scale around `#f97316`.
  - Neutrals: slate grays.
  - **Semantic order-status colors**, used everywhere status appears:
    pending=amber, confirmed=blue, preparing=indigo, ready=green,
    completed=slate, cancelled/rejected=red.
  - Standard radius / spacing / typography scale mapped to shadcn theme vars.
- File layout: `src/components/ui/*` (shadcn primitives),
  `src/components/dashboard/*` (shell pieces), `src/lib/utils.ts`.

### Dashboard shell
New **`src/app/dashboard/layout.tsx`** (server component) loads the current user,
role keys, and restaurant name once via existing `requireDashboardUser()`, and
wraps every dashboard page in:

- **Left sidebar** — ServeOS wordmark + restaurant name; **role-gated nav**:
  - Home — owner, manager (setup-focused; staff don't see it)
  - Orders — `orders:manage` (owner, manager, staff)
  - Menu — `menu:manage` (owner, manager)
  - Branches — `menu:manage`
  - Banners — `menu:manage`
  - Settings · Fulfillment — `fulfillment:manage` (owner, manager)
  - Active-item highlight; collapses to a drawer at tablet width.
- **Topbar** — breadcrumb / page context, a **pending-orders bell** (reuses the
  existing pending-order count), and a user menu (name, role, sign out).
- **`PageHeader`** component — consistent title + optional description + primary
  action button (e.g. "＋ New product") on every page.

Nav items render only when the user's role keys grant the gating permission, so
staff see just Home + Orders, managers/owners see the rest.

### Dashboard Home (new)
`/dashboard` currently only redirects. It becomes a real landing page:
- **Onboarding setup checklist** — add a branch → add menu items → set opening
  hours → start accepting orders ("go live"). Each item links to the relevant
  page and shows done/not-done based on existing data.
- **Today's order snapshot** — counts by status using existing order queries.
- Staff-only users (Orders is their sole permission) continue to land directly
  on Orders.

## Shared component library

shadcn primitives, extracted the first time a page needs one:
- **Forms**: Button, Input, Select, Textarea, Switch, Checkbox, plus a
  `FormField` wrapper (label + control + error + hint).
- **Data**: Table, Card, Badge (status/payment), EmptyState.
- **Actions & feedback**: Dialog / AlertDialog (confirm destructive actions),
  DropdownMenu (row + user menus), Tabs, **Toast** (Sonner).

These replace today's raw text links and unstyled forms.

## Page-by-page redesign

All pages get the shell, a `PageHeader`, the new components, a proper **empty
state**, and **toast feedback** on save/delete.

| Page | Redesign |
|---|---|
| **Home** (new) | Onboarding checklist + today's order snapshot |
| **Orders list** | Live-polling Table, status-filter Tabs (All / Pending / Preparing / Ready), status Badges, "new order" highlight, row → detail |
| **Order detail** | Summary + line-items + customer cards; state-machine action buttons (Confirm → Preparing → Ready → Complete / Cancel) and Mark-paid, each with confirm dialog + toast |
| **Menu** | Categories as sections; products in a Table (image, price, published Switch); delete via AlertDialog |
| **Product new/edit** | Real form — EN/AR fields paired, price, category Select, image upload, publish Switch, modifiers |
| **Category new/edit** | Real form |
| **Branches list + detail** | Branch cards/Table; detail form with ordering settings |
| **Fulfillment** | Tabbed settings: Hours · Delivery areas · VAT · Accepting-orders toggle |
| **Banners** | List + create/edit form |

## States, feedback & error handling

- **Server-action feedback**: wrap form submits in a small client component using
  React 19 `useFormStatus` / `useActionState` — submit buttons show a pending
  spinner + disabled state; success/failure fires a Toast. No silent reloads.
- **Loading**: skeleton rows for tables while data/polling resolves.
- **Empty states**: every list (e.g. "No products yet — add your first item").
- **Errors**: existing `DomainError` / validation errors surface inline on the
  field or as a Toast instead of throwing. Add a dashboard **`error.tsx`**
  boundary (friendly message + retry) and `notFound()` for missing entities.
- **Destructive actions**: delete / cancel-order go through an AlertDialog confirm.
- **Accessibility**: largely free via Radix (keyboard nav, focus, ARIA); keep
  labels and focus states.

## Testing & rollout

- Server logic is already covered by the vitest suite; this work is
  presentational, so verify with **typecheck + `next build` + manual checks per
  page**, and extend the existing **Playwright e2e** with one happy-path
  dashboard flow (login → Orders → advance status).
- **Ship order** (each a reviewable, shippable unit):
  Foundation → Shell → Home → Orders → Menu → Branches → Fulfillment → Banners.

## Risks

- **Tailwind v4 + shadcn on Next 16 / React 19**: the project's `AGENTS.md` warns
  this is a non-standard Next.js build. Tailwind/shadcn are styling-layer concerns
  and expected to work, but the foundation step must verify setup with a real
  `next build` before page migration begins.
- **Server-action + client-feedback pattern**: pages currently rely on
  redirect-on-submit. Introducing `useActionState`/toast must preserve existing
  behavior (RLS, redirects) — migrate per page, verifying each.
