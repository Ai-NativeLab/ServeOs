# Cross-Channel Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use mo-ai:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One reporting layer, two surfaces. On the **web dashboard**, a manager sees everything the business did across **POS and online together** — sales sliced by channel / branch / cashier / payment method, refunds and voids, discounts, tenders and tips, the daily reconciliation summary, and the inventory and purchasing reports. On the **POS (Electron)**, a cashier gets the operational **X report** (mid-shift snapshot, non-resetting) and **Z report** (shift close), scoped to their device and branch. Gate it correctly: add `reports:view` + `reports:financial` permissions, enforce the dormant `advanced_analytics` entitlement on the advanced reports, and keep basic sales in the base plan. Implements `docs/ailab/specs/2026-07-24-cross-channel-reporting-design.md` (Spec 10, decision **D6**).

**Architecture:** This is a **reading** layer, not a new data model. The report data-access layer is `src/server/analytics/service.ts` **extended** — a set of tenant-scoped aggregation functions that join alongside the existing six, each opening `withTenant(tenantId, tx => …)` so every query is RLS-scoped. Cross-channel is **a union over one table**: `orders.channel` (`web | pos`) already distinguishes POS from web, so a combined report ignores `channel` and a sliced one `GROUP BY channel`. The **web** path enters through the dashboard (`requireReportsPermission` → `requireFeature(tenantId, "advanced_analytics")` for advanced reports) and renders through the existing Recharts + `Card`/`Table` components. The **POS** path enters through the bridge (`window.pos.xReport()` / `zReport()` → `ipcRenderer.invoke` → electron main → `GET /api/pos/v1/reports/{x,z}` with device Bearer + `X-POS-Cashier`), where `requirePosCashier` scopes every read to the signed-in device/branch. The platform analytics in `src/server/analytics/platform.ts` are cross-tenant and **out of scope** — untouched.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres (RLS via `withTenant`), Recharts (client components), Electron (`apps/pos`), Vitest against a remote Supabase Postgres.

## Global Constraints

- **Extend, do not replace.** `src/server/analytics/service.ts` keeps its six aggregations and their signature shape — `(tenantId: string, days: number, …)`, body in `withTenant`, returning plain typed rows the way `getRevenueTrend` does, day-bucketing with `AT TIME ZONE ${timezone}` via the existing `getTenantTimezone(tenantId)`. New functions join beside them.
- **Every query is tenant-scoped.** No new aggregation ever runs outside `withTenant`. Each new function has an RLS-isolation test proving a second tenant's rows never leak in.
- **Dependency-guarded reads (load-bearing).** Spec 10 reads tables owned by Specs 2/3/7/8/9 (`refunds`, `reconciliation_runs`, `stock_ledger`, `inventory_lots`, `stock_counts`, `purchase_orders`, `po_receipts`, `suppliers`, `pos_shifts`, `cash_counts`). **None of those exist in this repo yet** — only Spec 4 (audit) is in flight. So every read of a not-yet-shipped table is guarded by a single `tableExists(tx, name)` helper (`SELECT to_regclass('public.<name>')`); when the source is absent the function returns `[]`/zeros and the UI hides that section — never a `relation does not exist` error. This is exactly the spec's *"Dependency not yet shipped → the section is hidden rather than erroring; sections degrade independently"* edge case, and it is what makes this plan buildable and green **today**. Reports over tables that **do** exist (`orders`, `order_items`, `order_payments`, `pos_adjustment_events`, `branches`, `users`) are built fully.
- **Basic stays free, advanced is paywalled.** The six existing aggregations **and** `getSalesByChannel` stay in the base plan with no entitlement check. Every advanced report is guarded by `requireFeature(tenantId, "advanced_analytics")` at the surface (page/route), which throws `FeatureNotAvailableError` when the plan flag is off (`plans.seed.ts`: enterprise `true`, basic/pro `false`). The aggregation functions themselves stay pure SQL — the gate lives at the boundary, never inside `service.ts`.
- **Financial reports are permission-gated and omitted server-side.** A manager without `reports:financial` never has the financial cards *computed or sent* — server-side omission via `can(ctx.roleKeys, "reports:financial")`, not CSS hiding.
- **POS reports are operational, not paywalled.** X/Z reports are gated only by the cashier being signed in with `pos:sell` and the shift being theirs (`requirePosCashier` scopes device/branch). No `advanced_analytics` check.
- **No new required tables.** The only schema is the **optional, deferred** rollups in Task 7 — not built for MVP.
- Run `npx tsc --noEmit && npx eslint <files>` before every commit. Both must be clean.

---

## File Structure

**Authorization + entitlement**
- Modify: `src/server/rbac/permissions.ts` — add `reports:view`, `reports:financial` (owner + manager).
- Test: `src/server/rbac/permissions.test.ts`.
- Create: `src/app/dashboard/analytics/reports-permission.ts` — `requireReportsPermission`, `canFinancialReports`, `requireAdvancedReports`.

**Report data-access layer (service extension)**
- Create: `src/server/analytics/deps.ts` — `tableExists(tx, name)` dependency guard.
- Modify: `src/server/analytics/service.ts` — the new cross-channel aggregations.
- Create: `src/server/analytics/pos-reports.ts` — `buildXReport`, `buildZReport`.
- Test: `src/server/analytics/reports.test.ts`, `src/server/analytics/pos-reports.test.ts`.

**Web dashboard**
- Modify: `src/app/dashboard/analytics/page.tsx` — gate `menu:manage` → `reports:view`; add the Sales-by-channel card (base).
- Create: `src/app/dashboard/analytics/sales/page.tsx`, `.../financial/page.tsx`, `.../inventory/page.tsx`, `.../purchasing/page.tsx`.
- Create: `src/app/dashboard/analytics/BreakdownChart.tsx` (reusable Recharts bar), `src/app/dashboard/analytics/UpgradePrompt.tsx`.

**POS (bridge + screens)**
- Create: `src/app/api/pos/v1/reports/x/route.ts`, `src/app/api/pos/v1/reports/z/route.ts`.
- Modify: `apps/pos/electron/pos-main.ts`, `apps/pos/electron/preload.ts`, `apps/pos/electron/main.ts`, `apps/pos/src/pos-bridge.d.ts`, `apps/pos/src/App.tsx`.
- Create: `apps/pos/src/screens/XReport.tsx`, `apps/pos/src/screens/ZReport.tsx`.

**Optional / deferred (Task 7 only)**
- Create: `src/server/analytics/rollup-schema.ts` — `daily_sales_rollup`, `daily_inventory_rollup`; `drizzle/00XX_*.sql` (RLS hand-appended).

---

## Task 1: Permissions + entitlement guards

Two new permissions and the surface helpers that compose them with the `advanced_analytics` entitlement. This is the enforcement D6 requires — the flag is seeded but has never been read.

**Files:**
- Modify: `src/server/rbac/permissions.ts`
- Test: `src/server/rbac/permissions.test.ts`
- Create: `src/app/dashboard/analytics/reports-permission.ts`

**Interfaces:**
- Produces: permissions `reports:view`, `reports:financial` (owner + manager, **not** staff).
  - `function requireReportsPermission(): Promise<DashboardContext>` — mirrors `requireMenuPermission`, `authorize(ctx.roleKeys, "reports:view")`.
  - `function canFinancialReports(ctx: DashboardContext): boolean` — `can(ctx.roleKeys, "reports:financial")`.
  - `function requireAdvancedReports(tenantId: string): Promise<void>` — `requireFeature(tenantId, "advanced_analytics")`.

- [ ] **Step 1: Write the failing permission test.** Append to `src/server/rbac/permissions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "./permissions";

describe("reports permissions", () => {
  it("reports:view + reports:financial are held by owner and manager", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain("reports:view");
      expect(ROLE_PERMISSIONS[role]).toContain("reports:financial");
    }
  });
  it("neither is held by staff", () => {
    expect(ROLE_PERMISSIONS.staff).not.toContain("reports:view");
    expect(ROLE_PERMISSIONS.staff).not.toContain("reports:financial");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/server/rbac/permissions.test.ts` → FAIL (permission not in the array).

- [ ] **Step 3: Implement the permissions.** In `src/server/rbac/permissions.ts` add `"reports:view",` and `"reports:financial",` to `PERMISSIONS`, then append both to the `owner` and `manager` arrays in `ROLE_PERMISSIONS`. Leave `staff` and `super_admin` untouched.

- [ ] **Step 4: Implement the surface helpers.** Create `src/app/dashboard/analytics/reports-permission.ts`:

```ts
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize, can } from "@/server/rbac/authorize";
import { requireFeature } from "@/server/entitlements/service";

/** Gate for the reports pages. Mirrors requireMenuPermission. */
export async function requireReportsPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "reports:view");
  return ctx;
}

/** Financial cards are computed only when this is true (server-side omission). */
export function canFinancialReports(ctx: DashboardContext): boolean {
  return can(ctx.roleKeys, "reports:financial");
}

/** Throws FeatureNotAvailableError on a base/pro plan; resolves on enterprise. */
export async function requireAdvancedReports(tenantId: string): Promise<void> {
  await requireFeature(tenantId, "advanced_analytics");
}
```

- [ ] **Step 5: Run + typecheck + lint.** `npx vitest run src/server/rbac/permissions.test.ts && npx tsc --noEmit && npx eslint src/server/rbac src/app/dashboard/analytics/reports-permission.ts` → PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/rbac/permissions.ts src/server/rbac/permissions.test.ts src/app/dashboard/analytics/reports-permission.ts
git commit -m "feat(reports): reports:view + reports:financial permissions and advanced_analytics entitlement guards"
```

---

## Task 2: Cross-channel sales aggregations

The core of the web layer. New functions in `service.ts` that add the channel / branch / cashier / payment-method / discount / tender-tip breakdowns. All ground on tables that **exist today** (`orders`, `order_payments`, `pos_adjustment_events`, `branches`, `users`). The existing revenue/AOV/top-products aggregations already span both channels because they never filter `channel`; these add the grouping.

**Files:**
- Modify: `src/server/analytics/service.ts`
- Test: `src/server/analytics/reports.test.ts`

**Interfaces (all `(tenantId: string, days: number)` unless noted, body in `withTenant`):**
- `getSalesByChannel → { channel: "web" | "pos"; revenue: number; orderCount: number; averageOrderValue: number }[]` — `GROUP BY channel`. **Base plan.**
- `getSalesByBranch → { branchId: string; branchName: string; revenue: number; orderCount: number }[]` — `orders` JOIN `branches`.
- `getSalesByCashier → { cashierUserId: string | null; cashierName: string | null; revenue: number; orderCount: number }[]` — LEFT JOIN `users`; a null `cashier_user_id` bucket **is** the web/online row.
- `getSalesByPaymentMethod → { method: "cash" | "card" | "other"; amount: number; count: number }[]` — `order_payments` JOIN `orders` (date window on `placed_at`), `GROUP BY method`, sum `amount`.
- `getDiscountsGiven → { total: number; byReason: { reasonCode: string; amount: number; count: number }[]; byCashier: { cashierUserId: string; cashierName: string | null; amount: number; count: number }[] }` — `pos_adjustment_events` (`line_discount`, `order_discount`) UNION `orders.discountAmount`.
- `getTendersAndTips → { byMethod: { method: string; amount: number; count: number }[]; tips: number; cashTendered: number; cashChange: number }` — from `order_payments`. **Financial.**

- [ ] **Step 1: Write the failing tests.** Create `src/server/analytics/reports.test.ts`. Reuse the exact seeding shape from `src/server/analytics/service.test.ts` (`db.insert(tenants)`, `seedDefaultPlans()`, `startTrial`, `createBranch`, `createProduct`, `placeOrder`, and the `backdate` helper). Seed a **mixed** fixture: two `channel: "web"` orders and two `channel: "pos"` orders (the POS ones via `placeOrder(..., { channel: "pos", cashierUserId })` plus `order_payments` rows — cash + card — and one `pos_adjustment_events` discount). Assert:

```ts
it("getSalesByChannel splits web vs pos and each row's AOV = revenue/orderCount", async () => {
  const rows = await getSalesByChannel(tenantId, 30);
  const web = rows.find((r) => r.channel === "web")!;
  const pos = rows.find((r) => r.channel === "pos")!;
  expect(web.orderCount).toBe(2);
  expect(pos.orderCount).toBe(2);
  expect(pos.averageOrderValue).toBeCloseTo(pos.revenue / pos.orderCount, 2);
});

it("CROSS-CHANNEL PARITY: combined revenue == Σ per-channel revenue", async () => {
  const [trend, byChannel] = await Promise.all([getRevenueTrend(tenantId, 30), getSalesByChannel(tenantId, 30)]);
  const combined = trend.reduce((s, p) => s + p.revenue, 0);
  const summed = byChannel.reduce((s, r) => s + r.revenue, 0);
  expect(summed).toBeCloseTo(combined, 2); // the invariant that proves the union
});

it("getSalesByPaymentMethod sums order_payments.amount by method", async () => {
  const rows = await getSalesByPaymentMethod(tenantId, 30);
  expect(rows.find((r) => r.method === "cash")!.amount).toBeGreaterThan(0);
});

it("getSalesByCashier buckets null cashier as the web/online row", async () => {
  const rows = await getSalesByCashier(tenantId, 30);
  expect(rows.some((r) => r.cashierUserId === null)).toBe(true);
});

it("getDiscountsGiven totals by reason and by cashier", async () => {
  const d = await getDiscountsGiven(tenantId, 30);
  expect(d.total).toBeGreaterThan(0);
  expect(d.byReason.length).toBeGreaterThan(0);
});

it("getTendersAndTips sums tips and cash tendered/change", async () => {
  const t = await getTendersAndTips(tenantId, 30);
  expect(t.byMethod.length).toBeGreaterThan(0);
});

it("RLS: a second tenant's orders never leak into any breakdown", async () => {
  const other = await setup("rls-b"); // rings its own sale
  const rows = await getSalesByChannel(tenantId, 30);
  const total = rows.reduce((s, r) => s + r.orderCount, 0);
  expect(total).toBe(4); // only tenantId's four orders
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/analytics/reports.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Implement.** Append to `src/server/analytics/service.ts`. Follow `getRevenueTrend` exactly — `getTenantTimezone`, a `since` date, `withTenant`, `tx.execute<Row>(sql\`…\`)`, map `Number(...)`. Canonical example (the rest mirror it):

```ts
export type SalesByChannelRow = { channel: "web" | "pos"; revenue: number; orderCount: number; averageOrderValue: number };

export async function getSalesByChannel(tenantId: string, days: number): Promise<SalesByChannelRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ channel: string; revenue: string; order_count: string }>(sql`
      SELECT channel, COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS order_count
      FROM orders WHERE placed_at >= ${since} GROUP BY channel ORDER BY channel
    `);
    return rows.map((r) => {
      const revenue = Number(r.revenue), orderCount = Number(r.order_count);
      return { channel: r.channel as "web" | "pos", revenue, orderCount, averageOrderValue: orderCount ? revenue / orderCount : 0 };
    });
  });
}
```

  - `getSalesByBranch`: `SELECT o.branch_id, b.name, SUM(o.total), COUNT(*) FROM orders o JOIN branches b ON b.id = o.branch_id WHERE o.placed_at >= ${since} GROUP BY o.branch_id, b.name`.
  - `getSalesByCashier`: `LEFT JOIN users u ON u.id = o.cashier_user_id`, `GROUP BY o.cashier_user_id, u.name` — `cashier_user_id` null bucket is web.
  - `getSalesByPaymentMethod`: `SELECT op.method, SUM(op.amount), COUNT(*) FROM order_payments op JOIN orders o ON o.id = op.order_id WHERE o.placed_at >= ${since} GROUP BY op.method`.
  - `getDiscountsGiven`: two grouped queries against `pos_adjustment_events` (`type IN ('line_discount','order_discount')`) joined to `orders` for the window, one `GROUP BY reason_code`, one `GROUP BY by_user_id` (join `users`), plus a scalar sum of `orders.discount_amount`; assemble `{ total, byReason, byCashier }`.
  - `getTendersAndTips`: sum `amount` `GROUP BY method`, plus scalar `SUM(tip_amount)`, `SUM(tendered_amount)`, `SUM(change_amount)` over the windowed join.

- [ ] **Step 4: Run to verify they pass.** `npx vitest run src/server/analytics/reports.test.ts && npx tsc --noEmit` → PASS, clean. The parity test is the proof the union is correct.

- [ ] **Step 5: Commit.**

```bash
git add src/server/analytics/service.ts src/server/analytics/reports.test.ts
git commit -m "feat(reports): sales by channel/branch/cashier/payment-method + discounts + tenders & tips (cross-channel union)"
```

---

## Task 3: Refunds & voids + daily reconciliation summary

Voids exist today (`pos_adjustment_events`); refunds (Spec 3) and reconciliation runs (Spec 7) **do not**. This task introduces the `tableExists` guard so the void half is computed fully and the refund/reconciliation halves degrade to empty until their specs land.

**Files:**
- Create: `src/server/analytics/deps.ts`
- Modify: `src/server/analytics/service.ts`
- Test: `src/server/analytics/reports.test.ts` (extend)

**Interfaces:**
- `type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]`
- `function tableExists(tx: Tx, name: string): Promise<boolean>`
- `getRefundsAndVoids(tenantId, days) → { voids: { type: string; amount: number; count: number }[]; refunds: { amount: number; count: number; byReason: { reasonCode: string; amount: number; count: number }[] } | null }` — `refunds: null` means "Spec 3 not shipped, hide the sub-section".
- `getReconciliationSummary(tenantId, days) → { day: string; expectedCash: number; countedCash: number; variance: number; matchedSettlementLines: number; unmatchedSettlementLines: number; fees: number }[]` — **Financial.** Returns `[]` when Spec 7 tables are absent.

- [ ] **Step 1: Write the failing tests.** Extend `reports.test.ts`:

```ts
it("getRefundsAndVoids reads voids from pos_adjustment_events; refunds null until Spec 3", async () => {
  // seed a line_void + order_void adjustment on a pos order
  const rv = await getRefundsAndVoids(tenantId, 30);
  expect(rv.voids.reduce((s, v) => s + v.count, 0)).toBe(2);
  expect(rv.refunds).toBeNull(); // refunds table does not exist yet → hidden, not errored
});

it("getReconciliationSummary degrades to [] when reconciliation_runs is absent", async () => {
  await expect(getReconciliationSummary(tenantId, 30)).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/analytics/reports.test.ts` → FAIL.

- [ ] **Step 3: Implement the guard.** Create `src/server/analytics/deps.ts`:

```ts
import { sql } from "drizzle-orm";
import type { db } from "@/db/client";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** True iff a table exists in the public schema. Lets a report over a
 * not-yet-shipped spec's tables return empty instead of raising
 * "relation does not exist" — sections degrade independently. */
export async function tableExists(tx: Tx, name: string): Promise<boolean> {
  const { rows } = await tx.execute<{ reg: string | null }>(sql`SELECT to_regclass(${`public.${name}`}) AS reg`);
  return rows[0]?.reg != null;
}
```

- [ ] **Step 4: Implement the aggregations.** In `service.ts`:
  - `getRefundsAndVoids`: inside `withTenant`, always query `pos_adjustment_events` (`type IN ('line_void','order_void')`) `GROUP BY type` joined to `orders` for the window → `voids`. Then `if (await tableExists(tx, "refunds"))` query Spec 3's `refunds` (+ `refund_lines` reason breakdown) → `refunds`; else `refunds: null`.
  - `getReconciliationSummary`: `if (!(await tableExists(tx, "reconciliation_runs"))) return []`. Otherwise aggregate `reconciliation_runs` / `reconciliation_exceptions` per day in tenant tz (expected vs counted cash, matched/unmatched settlement lines, fees), following the row-mapping style of `getRevenueTrend`. **Comment** that `cash_counts` (Spec 2) and `settlement_batches` (Spec 6) feed these runs; this report only reads the runs.

- [ ] **Step 5: Run to verify they pass.** `npx vitest run src/server/analytics/reports.test.ts && npx tsc --noEmit` → PASS, clean.

- [ ] **Step 6: Commit.**

```bash
git add src/server/analytics/deps.ts src/server/analytics/service.ts src/server/analytics/reports.test.ts
git commit -m "feat(reports): refunds & voids + daily reconciliation summary with dependency guard (Spec 3/7 degrade to empty)"
```

---

## Task 4: Inventory + purchasing reports

All source tables belong to Specs 8 (`stock_ledger`, `inventory_lots`, `stock_counts`, `stock_count_lines`, `storage_locations`, `inventory_items`) and 9 (`purchase_orders`, `po_receipts`, `po_receipt_lines`, `suppliers`) and **do not exist yet**. Every function here is written against the roadmap's canonical names, wrapped in `withTenant`, and short-circuited by `tableExists`. They are correct-shape and forward-ready; they return `[]` today and start returning data the moment Specs 8/9 migrate their tables — no signature change.

**Files:**
- Modify: `src/server/analytics/service.ts`
- Test: `src/server/analytics/reports.test.ts` (extend)

**Interfaces (all guarded; all `reports:view` + `advanced_analytics`):**
- `getInventoryValuation(tenantId) → { itemId: string; name: string; onHand: number; unitCost: number; value: number }[]` — `inventory_lots` remaining qty × cost.
- `getInventoryConsumption(tenantId, days) → { itemId: string; name: string; consumed: number }[]` — `stock_ledger` `movement_type = 'sale_deduction'`.
- `getInventoryWastage(tenantId, days) → { itemId: string; name: string; wasted: number }[]` — `stock_ledger` `movement_type = 'waste'`.
- `getCountVariance(tenantId, days) → { countId: string; itemId: string; name: string; counted: number; expected: number; variance: number }[]` — `stock_counts` / `stock_count_lines`.
- `getLowStock(tenantId) → { itemId: string; name: string; locationId: string; onHand: number; reorderPoint: number }[]` — items below reorder point per `storage_locations`.
- `getSpendBySupplier(tenantId, days) → { supplierId: string; name: string; poCount: number; spend: number }[]` — `purchase_orders` JOIN `suppliers`.
- `getReceivedVsInvoiced(tenantId, days) → { poId: string; poNumber: string; ordered: number; received: number; invoiced: number; variance: number }[]` — `po_receipts` / `po_receipt_lines` vs PO lines.

- [ ] **Step 1: Write the failing tests.** In `reports.test.ts`, assert graceful degradation against the current DB (tables absent):

```ts
it.each([
  ["getInventoryValuation", () => getInventoryValuation(tenantId)],
  ["getInventoryConsumption", () => getInventoryConsumption(tenantId, 30)],
  ["getInventoryWastage", () => getInventoryWastage(tenantId, 30)],
  ["getCountVariance", () => getCountVariance(tenantId, 30)],
  ["getLowStock", () => getLowStock(tenantId)],
  ["getSpendBySupplier", () => getSpendBySupplier(tenantId, 30)],
  ["getReceivedVsInvoiced", () => getReceivedVsInvoiced(tenantId, 30)],
])("%s returns [] (dependency guard) until its spec ships", async (_n, fn) => {
  await expect(fn()).resolves.toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/analytics/reports.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement.** Each function opens `withTenant`, first line `if (!(await tableExists(tx, "<primary_table>"))) return []`, then the aggregation SQL against the canonical tables. Example:

```ts
export async function getInventoryValuation(tenantId: string): Promise<InventoryValuationRow[]> {
  return withTenant(tenantId, async (tx) => {
    if (!(await tableExists(tx, "inventory_lots"))) return [];
    const { rows } = await tx.execute<{ item_id: string; name: string; on_hand: string; unit_cost: string; value: string }>(sql`
      SELECT l.item_id, i.name,
             SUM(l.remaining_qty) AS on_hand,
             AVG(l.unit_cost) AS unit_cost,
             SUM(l.remaining_qty * l.unit_cost) AS value
      FROM inventory_lots l JOIN inventory_items i ON i.id = l.item_id
      GROUP BY l.item_id, i.name ORDER BY value DESC
    `);
    return rows.map((r) => ({ itemId: r.item_id, name: r.name, onHand: Number(r.on_hand), unitCost: Number(r.unit_cost), value: Number(r.value) }));
  });
}
```

  Add a `// FORWARD (Spec 8/9): fixtures seeding real stock_ledger/PO rows + aggregation assertions land when these tables migrate.` comment above the block.

- [ ] **Step 4: Run + typecheck.** `npx vitest run src/server/analytics/reports.test.ts && npx tsc --noEmit` → PASS, clean.

- [ ] **Step 5: Commit.**

```bash
git add src/server/analytics/service.ts src/server/analytics/reports.test.ts
git commit -m "feat(reports): inventory (valuation/consumption/wastage/variance/low-stock) + purchasing (spend/received-vs-invoiced), dependency-guarded"
```

---

## Task 5: Web dashboard report pages

Move the analytics gate to `reports:view`, add the Sales-by-channel card (base) to the existing page, and add sibling pages for the advanced sections — each wrapping its advanced calls in `requireAdvancedReports` (upgrade prompt on `FeatureNotAvailableError`) and financial sections behind `canFinancialReports` (server-side omission). Reuses the existing `Card`/`Table`/`EmptyState` and Recharts.

**Files:**
- Modify: `src/app/dashboard/analytics/page.tsx`
- Create: `src/app/dashboard/analytics/sales/page.tsx`, `.../financial/page.tsx`, `.../inventory/page.tsx`, `.../purchasing/page.tsx`
- Create: `src/app/dashboard/analytics/BreakdownChart.tsx`, `src/app/dashboard/analytics/UpgradePrompt.tsx`

- [ ] **Step 1: Re-gate + extend the main page.** In `page.tsx`, replace the `requireMenuPermission` import/call with `requireReportsPermission` from `./reports-permission`. Add `getSalesByChannel` to the existing `Promise.all` and render one new `Card` ("Sales by channel", base — no entitlement). Keep the existing `EmptyState` behaviour. Add a small sub-nav (links to `sales` / `financial` / `inventory` / `purchasing`) in the `PageHeader` action row.

- [ ] **Step 2: Build the reusable client chart + upgrade prompt.**
  - `BreakdownChart.tsx` (`"use client"`) — a Recharts `BarChart` over `{ label: string; value: number }[]`, styled like `RevenueChart.tsx` (`var(--color-primary)`, `ResponsiveContainer`, `h-72`).
  - `UpgradePrompt.tsx` — a `Card` reading "Advanced reports are on the Enterprise plan" with a link to `/dashboard/settings/billing`. Rendered where an advanced section is entitlement-blocked.

- [ ] **Step 3: Build the advanced pages.** Each is a server component that calls `requireReportsPermission()`, parses `range`, then:

```tsx
// sales/page.tsx (advanced: branch, cashier, payment-method)
const ctx = await requireReportsPermission();
try {
  await requireAdvancedReports(ctx.tenantId);
} catch (e) {
  if (e instanceof FeatureNotAvailableError) return <UpgradePrompt />;
  throw e;
}
const [byBranch, byCashier, byMethod] = await Promise.all([
  getSalesByBranch(ctx.tenantId, days),
  getSalesByCashier(ctx.tenantId, days),
  getSalesByPaymentMethod(ctx.tenantId, days),
]);
// render Cards + BreakdownChart + Tables; each empty section shows EmptyState
```

  - `financial/page.tsx` — additionally: `if (!canFinancialReports(ctx)) return <EmptyState title="No access" .../>;` **before** computing `getTendersAndTips` / `getReconciliationSummary`, so a role without `reports:financial` never triggers the query (server-side omission, per the spec). Also renders `getRefundsAndVoids` and `getDiscountsGiven`.
  - `inventory/page.tsx` — `getInventoryValuation` / `Consumption` / `Wastage` / `CountVariance` / `LowStock`; each empty array renders its own "Not available yet" `EmptyState`, so the page degrades section-by-section while Spec 8 is pending.
  - `purchasing/page.tsx` — `getSpendBySupplier` / `getReceivedVsInvoiced`, same degradation.

- [ ] **Step 4: Typecheck + lint + build-check.** `npx tsc --noEmit && npx eslint src/app/dashboard/analytics && npm run build` (build validates the App Router pages compile). Fix any RSC/client boundary issues (charts are `"use client"`).

- [ ] **Step 5: Commit.**

```bash
git add src/app/dashboard/analytics
git commit -m "feat(reports): reports:view-gated dashboard pages — sales/financial/inventory/purchasing with entitlement upgrade prompt and financial omission"
```

---

## Task 6: POS X / Z reports

The POS gets its own operational reports, served through the bridge, scoped to the signed-in device/branch via `requirePosCashier`. **X is a peek** (mid-shift, non-resetting, repeatable, identical output). **Z is the close** (ties to Spec 2's shift close, includes blind over/short, one immutable snapshot per shift). Both cover gross sales, tender breakdown, tips, discounts/voids, refunds, per-cashier sales, and drawer cash. Not entitlement-gated.

**Files:**
- Create: `src/server/analytics/pos-reports.ts`
- Test: `src/server/analytics/pos-reports.test.ts`
- Create: `src/app/api/pos/v1/reports/x/route.ts`, `src/app/api/pos/v1/reports/z/route.ts`
- Modify: `apps/pos/electron/pos-main.ts`, `apps/pos/electron/preload.ts`, `apps/pos/electron/main.ts`, `apps/pos/src/pos-bridge.d.ts`, `apps/pos/src/App.tsx`
- Create: `apps/pos/src/screens/XReport.tsx`, `apps/pos/src/screens/ZReport.tsx`

**Interfaces:**
- `type PosReport = { window: { from: string; to: string }; grossSales: number; orderCount: number; tenders: { method: string; amount: number; count: number }[]; tips: number; discounts: number; voids: number; refunds: number; perCashier: { cashierUserId: string; cashierName: string; sales: number; orders: number }[]; expectedDrawerCash: number }`
- `type ZReport = PosReport & { shiftId: string | null; countedCash: number | null; overShort: number | null; frozen: boolean }`
- `function buildXReport(ctx: PosCashierContext): Promise<PosReport>` — scoped to `ctx.branchId`, business-day window in tenant tz. Read-only, non-resetting.
- `function buildZReport(ctx: PosCashierContext, opts?: { shiftId?: string }): Promise<ZReport>` — same totals; when `pos_shifts`/`cash_counts` exist (guarded) filters by `order_payments.shiftId` and computes `countedCash`/`overShort`, else falls back to the day window with `countedCash: null`.

- [ ] **Step 1: Write the failing tests.** Create `src/server/analytics/pos-reports.test.ts`, seeding via `seedPosContext` (`@/server/pos/test-helpers`) and `recordSale` (as in the codebase's POS tests):

```ts
it("X report is repeatable and non-resetting — identical output twice, no state change", async () => {
  const { ctx } = await seedPosContext("owner");
  await recordSale(ctx, /* cash + card sale */);
  const a = await buildXReport(ctx);
  const b = await buildXReport(ctx);
  expect(b).toEqual(a);                 // pulling it changes nothing
  expect(a.grossSales).toBeGreaterThan(0);
  expect(a.tenders.length).toBeGreaterThan(0);
});

it("X report expectedDrawerCash = cash tenders − cash change (+ opening float when Spec 2 present)", async () => {
  const { ctx } = await seedPosContext("owner");
  await recordSale(ctx, /* cash 100 tendered 120 → change 20 */);
  const x = await buildXReport(ctx);
  expect(x.expectedDrawerCash).toBeCloseTo(80, 2); // no shift float yet
});

it("Z report falls back to the day window with countedCash null until Spec 2 ships", async () => {
  const { ctx } = await seedPosContext("owner");
  await recordSale(ctx, /* a sale */);
  const z = await buildZReport(ctx);
  expect(z.countedCash).toBeNull();
  expect(z.overShort).toBeNull();
});

it("per-cashier sales bucket by takenByUserId within the branch", async () => {
  const { ctx } = await seedPosContext("owner");
  await recordSale(ctx, /* a sale */);
  const x = await buildXReport(ctx);
  expect(x.perCashier.some((c) => c.cashierUserId === ctx.cashierUserId)).toBe(true);
});
```

  Note the cross-device isolation is already enforced by `requirePosCashier` (tested at the route layer / in `require-cashier` tests): a cashier whose tenant ≠ device tenant is rejected before `buildXReport` runs. State this in a comment rather than re-testing the guard.

- [ ] **Step 2: Run to verify they fail.** `npx vitest run src/server/analytics/pos-reports.test.ts` → FAIL.

- [ ] **Step 3: Implement `pos-reports.ts`.** `buildXReport(ctx)` opens `withTenant(ctx.tenantId)`, computes the day window (`AT TIME ZONE` tenant tz), and aggregates over `orders` (`branch_id = ctx.branchId`, `channel = 'pos'`) joined to `order_payments` / `pos_adjustment_events`: gross sales, tenders by method, `SUM(tip_amount)`, discounts/voids from `pos_adjustment_events`, refunds via `getRefundsAndVoids`'s guarded read, per-cashier from `order_payments.taken_by_user_id` JOIN `users`, and `expectedDrawerCash = openingFloat + cashTendered − cashChange`. `buildZReport` calls the same builder, then `if (await tableExists(tx, "pos_shifts") && opts?.shiftId)` re-scope to `order_payments.shift_id = opts.shiftId` and compute `countedCash`/`overShort` from `cash_counts`; else `{ shiftId: null, countedCash: null, overShort: null, frozen: false }`. **Comment:** persisting/freezing the Z snapshot at shift close is owned by Spec 2's close transaction; this builder provides the numbers.

- [ ] **Step 4: Implement the routes.** `src/app/api/pos/v1/reports/x/route.ts` mirrors `sales/route.ts`'s guard exactly:

```ts
export async function GET(req: NextRequest) {
  let ctx;
  try {
    ctx = await requirePosCashier(req);
    assertPermission(ctx, "pos:sell");
  } catch (e) {
    if (e instanceof PosAuthError || e instanceof PosCashierError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (e instanceof PosForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
  return NextResponse.json(await buildXReport(ctx));
}
```

  `reports/z/route.ts` is identical but calls `buildZReport(ctx, { shiftId: req.nextUrl.searchParams.get("shiftId") ?? undefined })`.

- [ ] **Step 5: Wire the bridge.** In `pos-main.ts` add `PosReport`/`ZReport` types and `xReport()` / `zReport(shiftId?)` methods (GET with `authHeaders()`, mirroring `getOrders`). In `preload.ts` add `xReport` / `zReport` to `PosBridge` and the `exposeInMainWorld` object. In `main.ts` register `ipcMain.handle("pos:xReport", …)` / `("pos:zReport", …)`. Update `apps/pos/src/pos-bridge.d.ts` to match.

- [ ] **Step 6: Build the screens.** `apps/pos/src/screens/XReport.tsx` and `ZReport.tsx` — read-only summaries calling `window.pos.xReport()` / `zReport()`, rendering the tender breakdown, tips, discounts/voids, per-cashier list, and expected drawer cash; Z additionally shows counted vs expected over/short when present (else "shift close & drawer count arrive with Shifts — Spec 2"). Add a "Reports" entry to `App.tsx` nav (visible when a cashier is signed in). Handle the empty/"no open shift" state per the spec (no error).

- [ ] **Step 7: Run + typecheck + lint.**

```bash
npx vitest run src/server/analytics/pos-reports.test.ts && npx tsc --noEmit
npx eslint src/server/analytics src/app/api/pos/v1/reports apps/pos
```

  Expected: PASS, clean.

- [ ] **Step 8: Commit.**

```bash
git add src/server/analytics/pos-reports.ts src/server/analytics/pos-reports.test.ts src/app/api/pos/v1/reports apps/pos
git commit -m "feat(reports): POS X (mid-shift, non-resetting) + Z (shift close) reports via the POS bridge, scoped by requirePosCashier"
```

---

## Task 7 (OPTIONAL / DEFERRED): nightly rollups

**Do not build this for the MVP.** On-the-fly aggregation inside `withTenant` is the shipped strategy; a 365-day live query is allowed. This task is the named escape hatch for when a tenant's long-range cross-channel/inventory reports get slow — it is written here only so the shape is agreed. Skip it unless a real performance problem is observed.

**Files (when built):**
- Create: `src/server/analytics/rollup-schema.ts` — `daily_sales_rollup` (grain `(tenantId, day, branchId, channel)` → revenue, order count, refunds, discounts, tips, tender-by-method) and `daily_inventory_rollup` (grain `(tenantId, day, branchId, itemId)` → on-hand qty, valuation, consumption, wastage). Both tenant-scoped, **FORCE RLS** (hand-append the policy block to the generated migration, as `drizzle/0016_bitter_beast.sql` does).
- Create: a nightly job populating them from `orders` + `order_payments` (sales) and `stock_ledger` (inventory).
- Modify: `service.ts` long-range functions to read the rollup when the range exceeds a threshold and the rollup is fresh, else fall back to live.

- [ ] **Step 1 (deferred):** Only start when profiling shows a slow report. The rollups are pure caches — derivable from source tables, safe to drop and rebuild — so introducing them later is non-breaking: the function signatures do not change, only their internals choose rollup-vs-live. **Leave unchecked; this task is intentionally not part of the MVP PR.**

---

## Task 8: Full-suite verification, manual acceptance, PR

**Files:** none — this task proves the spec.

- [ ] **Step 1: Run everything.**

```bash
npm test
npx tsc --noEmit
npx eslint src apps/pos
```

  Expected: all PASS, all clean. Fix anything that is not before continuing.

- [ ] **Step 2: Walk the spec's acceptance path.** With `npm run dev` + `npm run pos:dev` on a tenant paired to a POS device:
  - [ ] Ring a POS sale (cash + card, one discount) and place a web order. On `/dashboard/analytics`, confirm the Sales-by-channel card shows **both** channels and combined revenue equals the sum of the two channel rows.
  - [ ] As an **owner** (enterprise plan), open `/dashboard/analytics/sales` and `/financial` → advanced breakdowns, tenders & tips, discounts render.
  - [ ] Downgrade the tenant to **basic** (or use a basic tenant) → the advanced pages render the **upgrade prompt**; the base analytics page still renders.
  - [ ] As a role **without** `reports:financial` → the financial page omits tenders/reconciliation (no data in the response, not merely hidden).
  - [ ] Open `/dashboard/analytics/inventory` and `/purchasing` → each section shows its "not available yet" empty state (Spec 8/9 pending) **without** erroring.
  - [ ] On the POS, open the **X report** twice → identical numbers, nothing changes; tender breakdown, tips, per-cashier sales, and expected drawer cash match the sale just rung.
  - [ ] Open the **Z report** → same totals; the over/short block reads "arrives with Shifts (Spec 2)".

- [ ] **Step 3: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(reports): cross-channel dashboard reports + POS X/Z, advanced_analytics enforced" --body "$(cat <<'EOF'
Implements docs/ailab/specs/2026-07-24-cross-channel-reporting-design.md (Spec 10, decision D6).

- Web dashboard reports extending src/server/analytics/service.ts: sales by
  channel/branch/cashier/payment-method, discounts, tenders & tips, refunds &
  voids, daily reconciliation. Cross-channel = a union over orders.channel; the
  parity invariant (Σ per-channel revenue == combined) is tested.
- Two permissions: reports:view + reports:financial (owner + manager). The
  dashboard gate moves from menu:manage to reports:view; financial sections are
  omitted server-side without reports:financial.
- The dormant advanced_analytics entitlement is finally enforced: base sales +
  sales-by-channel stay free; every advanced report throws FeatureNotAvailableError
  on a base/pro plan (upgrade prompt) and returns data on enterprise.
- POS X report (mid-shift, non-resetting, repeatable) and Z report (shift close)
  served through the POS bridge, scoped to device/branch by requirePosCashier.
- Reads owned by Specs 2/3/7/8/9 (refunds, reconciliation, inventory, purchasing,
  shift over/short) are dependency-guarded with to_regclass: they degrade to empty
  and hide their section today, and light up with no signature change when those
  specs migrate their tables. Nightly rollups are specced but deferred.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- *Two permissions* — `reports:view` + `reports:financial` (owner + manager, not staff) → **Task 1**.
- *Entitlement enforcement (D6)* — `requireAdvancedReports` = `requireFeature(tenantId, "advanced_analytics")`; base sales + `getSalesByChannel` ungated; advanced reports gated at the surface → **Tasks 1, 5**.
- *Sales breakdowns (channel/branch/cashier/payment-method), discounts, tenders & tips* — cross-channel union over `orders.channel`, `order_payments`, `pos_adjustment_events`; parity invariant tested → **Task 2**.
- *Refunds & voids + daily reconciliation* — voids from `pos_adjustment_events` (real); refunds/reconciliation dependency-guarded → **Task 3**.
- *Inventory (valuation/consumption/wastage/variance/low-stock) + purchasing (spend/received-vs-invoiced)* — canonical-name aggregations, dependency-guarded → **Task 4**.
- *Web dashboard surfaces* — `reports:view` gate, base + advanced pages, upgrade prompt, financial server-side omission → **Task 5**.
- *POS X / Z reports* — non-resetting peek vs shift close, per-cashier + drawer, `requirePosCashier`-scoped bridge → **Task 6**.
- *Optional rollups* — `daily_sales_rollup` / `daily_inventory_rollup`, FORCE RLS, explicitly deferred → **Task 7**.
- *Testing (service RLS, parity, entitlement, authorization, POS repeatability, degradation) + manual acceptance* — every task, plus **Task 8**.

**One deliberate deviation from the spec:** the spec presents refunds (Spec 3), reconciliation (Spec 7), inventory (Spec 8), purchasing (Spec 9), and the Z report's shift over/short + `order_payments.shiftId` scoping (Spec 2) as live data sources. **None of those tables exist in this repo yet** — this is Spec 10 being built ahead of its dependencies, exactly as the roadmap sequences (10 depends on 2/3/6/7/8/9). Rather than block the entire reporting layer, this plan builds every report that grounds on tables shipped today (`orders`, `order_items`, `order_payments`, `pos_adjustment_events`, `branches`, `users`) **fully**, and wraps every read of a not-yet-shipped table in the `tableExists` (`to_regclass`) guard so it returns empty and its dashboard section hides — which is precisely the spec's *"Dependency not yet shipped → hidden rather than erroring; sections degrade independently"* edge case, promoted from an error path to the primary design. The function signatures are final and written against the roadmap's canonical table/column names, so when Specs 2/3/7/8/9 migrate their tables the reports light up with **no signature change** — only the addition of aggregation-assertion fixtures (flagged with `// FORWARD` comments). If a reviewer wants those reports demonstrated against real data in this PR, the only missing piece is the upstream tables, not this layer.

**Type consistency:** `tableExists` (Task 3) is the single guard consumed by every dependency-blocked read in Tasks 3, 4, and 6. `PosCashierContext` (`src/server/pos/require-cashier.ts`) is the unchanged input to `buildXReport`/`buildZReport` (Task 6) and to the route guards, so device/branch scoping is identical to the existing `/api/pos/v1/sales` path. `DashboardContext` flows from `requireReportsPermission` into `canFinancialReports` and `requireAdvancedReports` (Task 1) and into every web page (Task 5). Each new aggregation keeps the `(tenantId, days)` → typed-rows contract of the existing six, so `service.ts` stays one coherent module and the analytics page composes old and new functions in the same `Promise.all`.
