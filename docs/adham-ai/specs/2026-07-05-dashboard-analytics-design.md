# ServeOS Dashboard Analytics — Design

**Date:** 2026-07-05
**Status:** Approved (design) — pending implementation (delegated to OpenCode)
**Scope:** Restaurant dashboard surface only (`/dashboard/analytics`)

## Problem

Beyond the Home page's basic "orders by status today" snapshot, restaurant owners have no
way to see how the business is trending — revenue over time, which products sell, how
orders break down operationally, or when demand peaks. This is the third and final
sub-project of the current dashboard-expansion round, after the Settings Hub and the
Publish-menu (URL + QR) page, both already shipped.

## Goal

A dedicated Analytics page giving owners/managers a real, at-a-glance read on business
performance over a selectable recent window — without adding any new database tables or
a caching/precomputation layer, since order volumes at this stage don't warrant it.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Placement | New top-level sidebar nav item, "Analytics" → `/dashboard/analytics` |
| Access | `menu:manage` permission (owner + manager — same audience as Menu/Branches/Banners); no new RBAC permission |
| Branch scope | Tenant-wide only — no per-branch filter in this version |
| Time range | 7 / 30 / 90 days via a `?range=` query param, default 30; plain links, no client state |
| Data source | Live SQL aggregation over existing `orders`/`order_items` tables — no new tables, no caching |
| Charting | **Recharts** (new dependency) for the revenue/volume trend chart; a small hand-built CSS-grid component for the peak-hours heatmap (not a Recharts chart type) |

## Non-goals (this pass)

- Branch filtering.
- Custom date-range picker beyond the 7/30/90 presets.
- Exporting/CSV download of analytics data.
- Real-time/live-updating charts.
- Any caching or precomputed-aggregate layer.
- Changes to the Home page's existing "today's orders" snapshot.

## Architecture

### Data layer — `src/server/analytics/service.ts` (new module)

A new module, parallel to existing bounded-context folders like `billing/` and
`entitlements/`. Every function takes `(tenantId: string, days: number)` and is
tenant-scoped via `withTenant` (orders/order_items are RLS-backed, same as every other
ordering query):

- **`getRevenueTrend(tenantId, days)`** — daily revenue (`SUM(total)`) and order count
  (`COUNT(*)`), grouped by calendar day over the range. Feeds the main chart.
- **`getTopProducts(tenantId, days, limit = 10)`** — aggregated from `order_items`
  (`productId`, `nameEn` snapshot, `SUM(quantity)`, `SUM(lineTotal)`), ranked by revenue.
  No join to `products` needed — `order_items` already snapshots the name.
- **`getOrdersByStatus(tenantId, days)`** — count per `OrderStatus`, reusing the existing
  labels/colors from `src/lib/order-status.ts` (`orderStatusMeta`) for visual consistency
  with the Orders list and Home snapshot.
- **`getFulfillmentSplit(tenantId, days)`** — count grouped by `fulfillmentType`
  (pickup/delivery).
- **`getAverageOrderValue(tenantId, days)`** — AOV (`AVG(total)`) for the selected range
  **and** for the prior equal-length range immediately before it, so the page can show a
  simple up/down delta indicator.
- **`getPeakHours(tenantId, days)`** — order counts grouped by day-of-week × hour-of-day
  (a 7×24 grid) over the range, for the heatmap.

### Page — `src/app/dashboard/analytics/page.tsx`

Async Server Component:
- `requireDashboardUser()` + `authorize(roleKeys, "menu:manage")` (same guard pattern as
  every other permission-gated dashboard page — see `src/app/dashboard/menu-permission.ts`
  for the exact function to reuse/mirror).
- Reads `range` from `searchParams` (`"7" | "30" | "90"`, default `"30"`).
- Fetches all six aggregates in one `Promise.all`.
- Renders, in order:
  1. `PageHeader` + a small range-selector (three links: 7d / 30d / 90d, active one
     highlighted, each just changing the `?range=` query param).
  2. Revenue + order-volume chart (Recharts) — a combo of daily revenue (line) and order
     count (bar), matching the brand's coral/teal palette already defined in
     `globals.css`'s CSS variables.
  3. Top products — a ranked table (name, quantity sold, revenue), reusing the existing
     `Table`/`Card` shadcn primitives already used throughout the dashboard.
  4. Orders by status + fulfillment split — small stat cards or a simple bar breakdown,
     using `orderStatusMeta`'s existing badge colors.
  5. Average order value — a single stat card with the range's AOV and a delta vs. the
     prior period (up/down arrow + percentage).
  6. Peak hours — a 7×24 CSS-grid heatmap (day rows × hour columns), cell background
     opacity/intensity mapped to order count, with a text label on hover/tap for the exact
     count.

### Navigation

- `src/components/dashboard/nav-items.ts` — add an "Analytics" entry gated by
  `has("menu:manage")`, positioned after "Home" and before "Orders" (or wherever reads
  best in the existing order — final placement is an implementation judgment call, not a
  design-locked requirement).
- `src/components/dashboard/Sidebar.tsx` — add the corresponding icon to the `ICONS` map
  (e.g. `BarChart3` from `lucide-react`, matching the existing 1.5px-stroke icon
  convention).

## States, feedback & error handling

- No forms, no mutations — this page is entirely read-only, so none of the existing
  `ToastForm`/`SubmitButton`/`AlertDialog` patterns apply.
- Empty state: a tenant with zero orders in the selected range should render a friendly
  `EmptyState` (reusing `src/components/dashboard/EmptyState.tsx`) instead of empty/broken
  charts.
- No new error boundary needed — the existing `src/app/dashboard/error.tsx` already
  covers this route.

## Testing & rollout

- All six `analytics/service.ts` functions get real vitest unit tests (real test DB,
  seeded orders spanning multiple dates/statuses/products/hours), asserting correct
  aggregation — this is genuine, valuable server logic to test, unlike a pure read+render
  page.
- The page itself is presentational: verified via `npx tsc --noEmit` and `npm run build`,
  the same convention used for every other dashboard page in this project.
- No e2e test is required for this pass (no critical user flow changes — Playwright
  coverage is reserved for auth/RBAC/checkout-critical paths per existing project
  convention).

## Risks

- **Peak-hours query complexity:** grouping by day-of-week × hour-of-day in SQL needs
  care with timezone handling (`orders.placedAt` is `timestamptz`) — should use the
  tenant's configured timezone (`tenants.timezone`) rather than UTC, so "peak hours" match
  what the restaurant actually experiences locally.
- **Empty/sparse data:** a brand-new tenant with very few orders will produce a mostly-empty
  chart and heatmap — the empty-state handling above covers the zero-order case, but a
  handful of orders will still look sparse. Accepted as normal for a new restaurant; not a
  defect to design around.
