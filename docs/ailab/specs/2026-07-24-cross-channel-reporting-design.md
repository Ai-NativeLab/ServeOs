# ServeOS — Cross-Channel Reporting Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** **Spec 10 — the capstone** of the core POS & operations roadmap (`docs/ROADMAP.md`). It gives a manager one place to see everything the business did — across the POS *and* the online storefront — and gives the POS its own operational **X / Z reports**. It is a reporting layer over data other specs produce, so it **depends on Spec 3 (Refunds & Sales History), Spec 4 (Audit & Fingerprint Log), Spec 6 (Payments & Gateway), Spec 7 (Transaction Reconciliation), Spec 8 (Inventory Core + Recipes/BOM), and Spec 9 (Suppliers & Purchasing)**. It adds almost no tables of its own: it reads theirs. This spec is Spec 10 and obeys locked decision **D6**.

## Context

Reporting already half-exists. `src/server/analytics/service.ts` runs **six on-the-fly aggregations** — revenue trend, top products, orders-by-status, fulfillment split, average order value, peak hours — each inside `withTenant(tenantId, tx => …)`, so every query is RLS-scoped to the caller's tenant. They surface on one page, `src/app/dashboard/analytics/page.tsx`, gated by `menu:manage`, and render through Recharts (`RevenueChart.tsx`, a `ComposedChart`). Platform-level, cross-tenant analytics live separately in `src/server/analytics/platform.ts` and are **out of scope here** — this spec is tenant-facing only.

Two facts from the specs below make cross-channel reporting cheap. First, **every order already carries `channel` (`web | pos`)** on the `orders` table (`src/server/ordering/schema.ts`), set by Spec 1. Second, the POS money model is real: `order_payments` records tenders and tips, and `pos_adjustment_events` records discounts and voids (`src/server/pos/tender-schema.ts`). So "sales across both channels" is not an integration — it is a query over one table, optionally grouped by `channel`.

## Problem

An owner still cannot answer the questions that matter at close of day. *How much came in on cash versus card versus online?* *Which cashier rang the most, and how much did they discount?* *What did we refund, and why?* *Does the counted drawer tie to recorded tenders and to the gateway's payout?* *What's my inventory worth, what did I waste, what did I spend with each supplier?* The six existing aggregations answer none of these, none of the money-sensitive ones are entitlement-gated, and the POS — where a cashier closes a shift — has **no report at all**. The `advanced_analytics` plan flag that should paywall the deep reports is defined in `PlanFeatures` and seeded (enterprise only) but **never enforced**.

## Goal

One reporting layer, two surfaces. On the **web dashboard**, a manager sees everything — sales sliced by channel / branch / cashier / payment method, refunds and voids, discounts, tenders and tips, the daily reconciliation summary, and the inventory and purchasing reports — spanning POS and online together. On the **POS (Electron)**, a cashier gets the operational **X report** (mid-shift snapshot) and **Z report** (shift close), scoped to their device and branch. Gate it correctly: enforce the dormant `advanced_analytics` entitlement for the advanced reports, keep basic sales in the base plan, and add `reports:view` and `reports:financial` permissions.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Reporting shape (D6) | **Cross-channel, dual-surface.** Web dashboard reports span POS + online; the POS gets operational X / Z reports. |
| Data source | **Extend `src/server/analytics/service.ts`, do not replace it.** New aggregations join alongside the existing six, same `withTenant` pattern. |
| Cross-channel | **Union over one table.** `orders.channel` already distinguishes POS from web; reports either ignore it (combined) or `GROUP BY channel`. No cross-source ETL. |
| Compute strategy | **On-the-fly for MVP.** Aggregate live inside `withTenant`. Nightly rollups are an *optional, deferred* escape hatch (below), not built now. |
| Entitlement | **Enforce `advanced_analytics`** for advanced reports; basic sales stay in the base plan. Via the existing `requireFeature(tenantId, "advanced_analytics")`. |
| New permissions | **`reports:view`** (owner + manager) for operational reports; **`reports:financial`** (owner + manager) gating reconciliation / settlement / tender reports. |
| Tenancy | **RLS via `withTenant`.** Every web query is tenant-scoped; every POS report is additionally device/branch-scoped through `requirePosCashier`. |

## Non-goals (deferred by explicit decision)

- Building rollup tables now → **on-the-fly is the MVP**; `daily_sales_rollup` / `daily_inventory_rollup` are optional and deferred until a tenant's long-range or cross-channel/inventory reports get slow.
- Platform / cross-tenant analytics → stays in `src/server/analytics/platform.ts`, untouched.
- Scheduled report emails / PDF exports / CSV downloads → later; this spec renders on screen and on the POS.
- Custom report builder, saved segments, cohort analysis → out of scope.
- Producing the underlying data (refunds, audit chain, settlements, stock ledger, POs) → owned by Specs 3, 4, 6, 7, 8, 9. This spec only reads it.

## Web dashboard reports (managers)

All of these are **new functions added to `src/server/analytics/service.ts`**, each following the existing signature shape — `(tenantId, days, …)`, body wrapped in `withTenant`, returning plain typed rows the way `getRevenueTrend` does. They render on the existing analytics page (or sibling pages under `src/app/dashboard/analytics/`) reusing the Recharts + `Card`/`Table` components already there. The catalog, by source and gate:

| Report | New function | Source | Permission | Entitlement |
|---|---|---|---|---|
| Revenue / top products / AOV (existing 6) | *(unchanged)* | `orders`, `order_items` | `reports:view` | base |
| Sales by channel | `getSalesByChannel` | `orders.channel` | `reports:view` | base |
| Sales by branch | `getSalesByBranch` | `orders` × `branches` | `reports:view` | `advanced_analytics` |
| Sales by cashier | `getSalesByCashier` | `orders.cashierUserId` × `users` | `reports:view` | `advanced_analytics` |
| Sales by payment method | `getSalesByPaymentMethod` | `order_payments.method` | `reports:view` | `advanced_analytics` |
| Refunds & voids | `getRefundsAndVoids` | Spec 3 refunds + `pos_adjustment_events` | `reports:view` | `advanced_analytics` |
| Discounts given | `getDiscountsGiven` | `pos_adjustment_events` + `orders.discountAmount` | `reports:view` | `advanced_analytics` |
| Tenders & tips | `getTendersAndTips` | `order_payments` | `reports:financial` | `advanced_analytics` |
| Daily reconciliation | `getReconciliationSummary` | Spec 7 runs/exceptions | `reports:financial` | `advanced_analytics` |
| Inventory (valuation/consumption/wastage/variance/low-stock) | `getInventory*` | Spec 8 `stock_ledger`, `inventory_lots`, `stock_counts` | `reports:view` | `advanced_analytics` |
| Purchasing (spend by supplier, received vs invoiced) | `getSpendBySupplier`, `getReceivedVsInvoiced` | Spec 9 `purchase_orders`, `po_receipts` | `reports:view` | `advanced_analytics` |

Function detail:

**Sales (base + advanced).** The existing revenue/top-products/AOV aggregations already span both channels because they never filter `channel` — POS sales land as `channel = 'pos'`, web as `'web'`, in the same `orders` rows. New breakdowns add the grouping:

- `getSalesByChannel` — `GROUP BY channel`: revenue, order count, AOV per channel.
- `getSalesByBranch` — `GROUP BY branch_id` joined to `branches`.
- `getSalesByCashier` — `GROUP BY cashier_user_id` joined to `users` (null cashier = web).
- `getSalesByPaymentMethod` — `GROUP BY order_payments.method` (cash / card / other; extended to gateway `card`/`wallet` once Spec 6 lands), summing `amount`.

**Refunds & voids** (`getRefundsAndVoids`) — refunds from **Spec 3**'s refund records; voids from `pos_adjustment_events` (`type IN ('line_void','order_void')`). Counts, amounts, and reason-code breakdown.

**Discounts given** (`getDiscountsGiven`) — from `pos_adjustment_events` (`line_discount`, `order_discount`) plus `orders.discountAmount`; totals by reason code and by cashier.

**Tenders & tips** (`getTendersAndTips`) — from `order_payments`: sum `amount` by `method`, sum `tipAmount`, cash `tenderedAmount`/`changeAmount`. **Financial** report.

**Daily reconciliation summary** (`getReconciliationSummary`) — reads **Spec 7**'s `reconciliation_runs` / `reconciliation_exceptions` (which draw on Spec 2's `cash_counts` and Spec 6's `settlement_batches`): expected vs counted cash, order↔tender integrity, matched/unmatched settlement lines and fees, per day in tenant timezone. **Financial** report.

**Inventory reports** (from **Spec 8**) — on-hand valuation (from `inventory_lots` remaining qty × cost), consumption and wastage (from `stock_ledger` by movement type: `sale_deduction`, `waste`), count variance (`stock_counts` / `stock_count_lines`), and low-stock (items below reorder point per `storage_location`).

**Purchasing reports** (from **Spec 9**) — spend by supplier (`purchase_orders` joined to `suppliers`) and received-vs-invoiced variance (`po_receipts` / `po_receipt_lines` against PO lines).

## POS reports (X / Z)

The POS is where a shift is worked and closed, so it gets its own **operational** reports — rendered in the Electron renderer (`apps/pos/src`), served through the POS bridge, never through the dashboard. Both are **scoped to the signed-in device and branch** via `requirePosCashier` (which already resolves `{ deviceId, tenantId, branchId, cashierUserId, permissions }`), so till 1 cannot read till 2's numbers.

- **X report — mid-shift snapshot, NON-resetting.** A read-only "where are we right now": gross sales, tender breakdown (cash / card / other), tips, discounts and voids, refunds, per-cashier sales, and expected drawer cash so far, for the *open* shift. A cashier can pull it any number of times; it changes nothing. It is the "count without closing" report.
- **Z report — shift close.** Ties to **Spec 2 (Shifts & Cash Drawer)**: it is generated **when the shift closes**, freezes the shift's totals, includes the blind-count over/short, and is the record that a shift happened and reconciled. It resets the running figures for the next shift. Filtered to that shift's `order_payments.shiftId`.

The X/Z distinction is the whole point: **X is a peek, Z is the close.** X can be run repeatedly and is non-destructive; Z is once per shift and is the audit record. Per-cashier sales and the drawer count appear on both.

| | **X report** | **Z report** |
|---|---|---|
| When | Any time mid-shift | At shift close (Spec 2) |
| Resets running totals | **No** | **Yes** |
| Repeatable | Yes, unlimited | No — one immutable snapshot |
| Includes blind over/short | No (expected only) | Yes (counted vs expected) |
| Purpose | Operational "where are we" | Audit record that the shift reconciled |

Both cover gross sales, tender breakdown, tips, discounts/voids, refunds, per-cashier sales, and drawer cash. These reports do **not** require `advanced_analytics` — they are operational necessities, gated only by the cashier being signed in with `pos:sell` and the shift being theirs.

## Entitlement & authorization

**Two new permissions** in `src/server/rbac/permissions.ts` (append to `PERMISSIONS`, extend `ROLE_PERMISSIONS`):

- `reports:view` — see operational/sales reports. **owner + manager.**
- `reports:financial` — see money-sensitive reports (reconciliation, settlement, tenders & tips). **owner + manager.**

The dashboard page's gate moves from `menu:manage` to `reports:view` (a new `requireReportsPermission()` helper mirroring `requireMenuPermission()` in `src/app/dashboard/menu-permission.ts`, calling `authorize(ctx.roleKeys, "reports:view")`). Financial sub-sections additionally `authorize(…, "reports:financial")`; a manager without it sees the operational reports but the financial cards are omitted server-side (never rendered, not merely hidden).

**Entitlement.** The **basic sales analytics** (the six existing aggregations + `getSalesByChannel`) stay in the base plan — no entitlement check. Every **advanced report** (branch/cashier/payment-method breakdowns, refunds & voids, discounts, tenders & tips, reconciliation, inventory, purchasing) is guarded by `requireFeature(tenantId, "advanced_analytics")` (`src/server/entitlements/service.ts`), which throws `FeatureNotAvailableError` when the plan flag is off. This is the enforcement D6 requires; the flag is already seeded (`plans.seed.ts`: enterprise `true`, basic/pro `false`) — this spec is what finally reads it. The POS X/Z reports are operational and are **not** entitlement-gated.

## Data model

This spec adds **no required tables** — it reads Specs 3/6/7/8/9's. The only new schema is **optional and deferred**: nightly **rollup** tables that pre-aggregate long-range history so a "last 12 months, by channel" query need not scan every order and ledger row live.

| Table (canonical) | Grain | Populated by | Status |
|---|---|---|---|
| `daily_sales_rollup` | (tenantId, day, branchId, channel) → revenue, order count, refunds, discounts, tips, tender-by-method | nightly job over `orders` + `order_payments` | **optional / deferred** |
| `daily_inventory_rollup` | (tenantId, day, branchId, itemId) → on-hand qty, valuation, consumption, wastage | nightly job over `stock_ledger` | **optional / deferred** |

Both are tenant-scoped with FORCE RLS if built. They are pure caches — derivable from source tables and safe to drop and rebuild. They are **not** in the MVP; they exist in this spec only so the escape hatch is named and its shape agreed. Until then, reports read source tables live.

## Architecture

```
                         WEB DASHBOARD (managers)                    POS (Electron renderer, apps/pos/src)
                 src/app/dashboard/analytics/*  (Recharts)           X-report screen   Z-report screen
                              │  requireReportsPermission()                   │   window.pos.* (preload bridge)
                              │  reports:view / reports:financial             │   ipcRenderer.invoke → electron main
                              ▼                                               ▼   Bearer device token + X-POS-Cashier
                 ┌──────────────────────────────┐                 GET /api/pos/v1/reports/x  |  .../reports/z
                 │  requireFeature(              │                            │   requirePosCashier()  → device+branch scoped
                 │    advanced_analytics)        │                            ▼
                 └──────────────┬───────────────┘                 ┌──────────────────────────────┐
                                │                                  │  POS report builder          │
                                ▼                                  │  (shift-scoped: order_payments│
        ╔═══════════════════════════════════════════════════════╗ │   .shiftId, cash_counts)     │
        ║   REPORT DATA-ACCESS LAYER (analytics/service.ts)      ║ └──────────────┬───────────────┘
        ║   every query: withTenant(tenantId, tx => …)  (RLS)   ║◄───────────────┘
        ╚═══════════════════════════════════════════════════════╝
             │           │             │            │            │
             ▼           ▼             ▼            ▼            ▼
      orders (web+pos   order_payments  Spec 7       Spec 8       Spec 9
      union on          + pos_adjust-   reconciliation stock_ledger purchase_orders
      channel) +        ment_events     _runs/         inventory_   po_receipts
      Spec 3 refunds    (tenders,tips,  exceptions,    lots,        suppliers
                        discounts,voids) settlement_    stock_counts
                                         batches
             └──── (optional) daily_sales_rollup / daily_inventory_rollup ────┘
```

The **report data-access layer** is `analytics/service.ts` extended: a set of tenant-scoped aggregation functions, each opening `withTenant` and unioning/joining across `orders` (both channels), `order_payments` + `pos_adjustment_events`, Spec 3 refunds, Spec 7 reconciliation, Spec 8 inventory, and Spec 9 purchasing. The **web** path enters through the dashboard with `requireReportsPermission` + `requireFeature`. The **POS** path enters through the bridge: renderer calls `window.pos.xReport()` / `zReport()` → `ipcRenderer.invoke` → electron main → `GET /api/pos/v1/reports/{x,z}` (device Bearer + `X-POS-Cashier`) → `requirePosCashier` scopes to device/branch/shift → the same service layer, filtered to the shift.

## Error handling / edge cases

- **No data in range** — every aggregation returns `[]`/zeros; the UI shows the existing `EmptyState`, never an error.
- **Feature off** — an advanced report requested on a base plan throws `FeatureNotAvailableError`; the dashboard renders an upgrade prompt for that card, base sales still render.
- **Financial permission missing** — a manager without `reports:financial` never has the financial cards computed or sent (server-side omission, not CSS hiding).
- **Timezone** — all day-bucketing uses `AT TIME ZONE <tenant.timezone>`, exactly as `getRevenueTrend` / `getPeakHours` already do; a sale at 01:00 local lands on the right business day.
- **Z report re-request** — a Z report is generated once at close and is immutable; re-opening it returns the frozen snapshot, it does not recompute.
- **X report during no open shift** — returns an empty/"no open shift" state, not an error.
- **Dependency not yet shipped** — if Spec 7/8/9 data is absent (feature not live for a tenant), the corresponding report section is hidden rather than erroring; sections degrade independently.
- **Cross-device isolation** — a POS report request whose cashier tenant ≠ device tenant is rejected by `requirePosCashier`; a cashier cannot pull another device's or branch's numbers.
- **Long ranges** — a 365-day on-the-fly query is allowed; if it becomes slow, the optional rollups are the remedy (deferred, not a correctness issue).

## Testing

- **Service (Vitest, tenant-scoped):** `getSalesByChannel` splits a fixture of mixed `web`/`pos` orders correctly; `getSalesByPaymentMethod` sums `order_payments.method`; `getDiscountsGiven` and `getRefundsAndVoids` read `pos_adjustment_events` + Spec 3 refunds; the reconciliation summary aggregates Spec 7 runs; inventory valuation/consumption/wastage read `stock_ledger`; spend-by-supplier reads Spec 9. Each asserts RLS isolation — a second tenant's rows never leak in.
- **Entitlement:** advanced report on a base plan throws `FeatureNotAvailableError`; on enterprise it returns data; base sales are reachable on every plan.
- **Authorization:** `reports:view` gates the page; a manager without `reports:financial` gets no financial data in the response.
- **POS reports:** X report is non-resetting and repeatable with identical output; Z report freezes shift totals, includes over/short, and is scoped to one `shiftId`; a cross-device request is rejected.
- **Cross-channel parity:** combined revenue equals `Σ` per-channel revenue for a fixture spanning both channels (the invariant that proves the union is correct).
- **Manual acceptance:** ring POS + web sales, refund one, discount one, close a shift → dashboard shows both channels, refund, discount, tenders and reconciliation; POS Z report ties to the drawer count.

## Roadmap

- **MVP:** the web aggregations extending `analytics/service.ts`, the two permissions, `advanced_analytics` enforcement, and the POS X/Z endpoints + screens — all on-the-fly.
- **Next:** scheduled report emails and CSV/PDF export (once Spec 5's outbound email layer exists).
- **Optional / deferred:** build `daily_sales_rollup` / `daily_inventory_rollup` and a nightly job, and switch long-range reports to read rollups when live aggregation gets slow.
- **Later:** hash-anchor the daily close report into Spec 4's audit chain; comparative period-over-period and multi-branch consolidated dashboards.
