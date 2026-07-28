# Feature PRD — Cross-Channel Reporting

**Trigger:** Use this when you are about to build a specific user flow or feature.
**Output:** A build-ready spec that can be handed directly to AI code generation or a developer.

**ID:** PRD-002
**Type:** Feature
**Parent PRD:** [PRD-001 — ServeOS](prd-high-serveos.md)
**Author:** Mohaned Sayed
**Date:** 2026-07-28
**Status:** Draft — Pending Review
**Target release:** Next sprint
**Version:** 1.0

## Version history

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-07-28 | Mohaned Sayed | Initial draft. Written **after** the technical spec, plan and GitHub issues existed — this PRD supplies the product intent those artefacts were missing. |

> **Provenance:** the technical design (`docs/ailab/specs/2026-07-24-cross-channel-reporting-design.md`), the implementation plan, and 16 GitHub issues under Epic #28 were all created before this PRD. The journeys in those issues are currently marked `DRAFT — no PRD exists`. **§5 of this document is their source of truth** — once approved, those issue journeys should be reconciled against it.

---

## 1. Context

ServeOS tenants sell through two channels — a counter POS and an online storefront — and both write to the same `orders` table. Despite that, an owner cannot see the two together. The dashboard has six basic aggregations (revenue trend, top products, orders by status, fulfilment split, average order value, peak hours) that silently span both channels without ever saying so, and the POS has **no report at all**.

This feature builds one reporting layer across two surfaces: manager reports on the web dashboard covering both channels, and operational X/Z reports on the POS. It also activates the `advanced_analytics` plan flag, which has been seeded since the subscription core shipped but has never been read by any code — meaning the Enterprise tier's headline capability is currently given away free.

**Parent PRD:** [PRD-001 — ServeOS](prd-high-serveos.md)
**Feature area:** Reporting & analytics
**Roadmap position:** Spec 10, the capstone of the core POS & operations roadmap. Locked decision **D6**.

## 2. Scope

### What is being built

**On the web dashboard** — reports spanning POS and online together:
- Sales by channel (free, all plans) — the hook that shows the layer exists
- Sales by branch, by cashier, by payment method (Enterprise)
- Discounts given, by reason and by cashier (Enterprise)
- Tenders & tips (Enterprise, financial)
- Refunds & voids (Enterprise)
- Daily reconciliation summary (Enterprise, financial)
- Inventory reports — valuation, consumption, wastage, count variance, low stock (Enterprise)
- Purchasing reports — spend by supplier, received vs invoiced (Enterprise)

**On the POS** — operational reports, free on every plan:
- **X report** — mid-shift snapshot, non-resetting, repeatable
- **Z report** — shift close, immutable, includes blind over/short

**Access control:**
- Two new permissions: `reports:view` and `reports:financial` (Owner + Manager)
- Enforcement of the dormant `advanced_analytics` entitlement
- The dashboard analytics gate moves from `menu:manage` to `reports:view`

**Correctness:**
- Revenue stops counting cancelled and rejected orders (a defect in shipped code)
- A written metric-definitions document so every report means the same thing

### What is not being built (out of scope)

- Platform / cross-tenant analytics — stays in `src/server/analytics/platform.ts`, untouched
- Scheduled report emails, PDF or CSV export — deferred until Spec 5's outbound email layer exists
- Custom report builder, saved segments, cohort analysis
- Real-time or live-updating reports
- Comparative period-over-period and multi-branch consolidated dashboards
- Nightly rollup tables — specced, explicitly deferred until a real performance problem is observed
- **Producing** the underlying data — refunds, settlements, stock ledger and purchase orders are owned by Specs 3, 6, 7, 8, 9. This feature only reads them.

**Sign-off:** [ ] Approved by ____________ on ____________

## 3. Current State vs Desired End State

| | Description |
|---|---|
| **Current state** | Six basic aggregations on one dashboard page, gated by `menu:manage` (a menu-editing permission). No channel breakdown, no branch/cashier/payment-method split, no refunds, discounts, tenders, reconciliation, inventory or purchasing reporting. **Revenue silently includes cancelled and rejected orders.** The POS has no report — a cashier closes a shift blind. `advanced_analytics` is seeded but never read, so Enterprise's headline capability is free. |
| **Desired end state** | An owner opens one place and sees everything the business did across both channels, with money-sensitive sections gated separately from operational ones. A cashier can pull a mid-shift X report as often as they like and run a Z report at close that ties to the drawer. Advanced reports are Enterprise-only and prompt an upgrade otherwise. Revenue means one defined thing everywhere. Reports whose source data does not exist yet say so plainly instead of erroring or showing a misleading zero. |

## 4. Permissions Impact

| Role | Can do | Cannot do |
|---|---|---|
| **Owner** | Everything: all operational and financial reports on the dashboard (subject to plan), plus POS X/Z reports | Nothing withheld |
| **Manager** | Operational reports (sales by channel/branch/cashier/payment method, discounts, inventory, purchasing) and POS X/Z reports. Holds `reports:financial` by default, so also financial reports | Nothing by default — but `reports:financial` is now *separable*, so an owner can revoke it and leave operational access intact |
| **Staff / Cashier** | POS X and Z reports for their own device and branch | Any dashboard report — holds neither `reports:view` nor `reports:financial` |
| **Platform Admin** | Unchanged — platform analytics are a separate, out-of-scope surface | Tenant-facing reports |

**New permissions:** `reports:view`, `reports:financial` — both Owner + Manager, neither held by Staff.

**Why two:** `reports:financial` is the first permission a Manager may hold separately from operational access. It is what lets an owner delegate day-to-day reporting to a shift manager **without** exposing the day's take. Both default to Owner + Manager, so no user loses access on release — the split exists to be used later.

**Entitlement interaction:** a user needs **both** the permission (their role allows it) **and** the entitlement (their plan includes it). Basic sales and sales-by-channel need no entitlement; every advanced report requires `advanced_analytics` (Enterprise only). POS X/Z reports require **no** entitlement — they are operational necessities.

## 5. User Stories & Acceptance Criteria

> Personas used throughout: **Amira** — tenant owner, two branches, Enterprise. **Karim** — shift manager, `reports:view` but `reports:financial` revoked. **Nour** — cashier working a till.

---

### Story 1 — Owner sees sales split by channel

**User story**
As an **owner**, I want to see my POS and online sales side by side, so that I can tell whether the storefront is adding business or just moving it off the till.

**Detailed flow**
1. Amira opens the dashboard and clicks **Analytics**.
2. The page loads with its existing cards plus a new **Sales by channel** card at the top.
3. The card shows one row per channel — POS and Online — with revenue, order count and average order value for each.
4. Amira switches the range selector to 7 / 30 / 90 days; the card updates with the rest of the page.

**Edge cases & error states**
- Tenant has orders in only one channel → the other channel's row is absent, not shown as zero
- Tenant has no orders in range → existing `EmptyState`, not a broken chart
- Tenant is on the Basic plan → **this card still shows**; it is deliberately free

**Acceptance criteria**
1. User sees a Sales-by-channel card on `/dashboard/analytics` showing revenue, order count and AOV per channel.
2. Combined revenue **equals** the sum of the per-channel rows — the parity invariant.
3. The card renders on **every plan**, including Basic, with no entitlement check.
4. The page is gated by `reports:view` (moved from `menu:manage`).
5. The `?range=` selector applies to this card as it does the rest of the page.

**Test cases**
1. Seed 2 web + 2 POS orders → card shows both channels with counts of 2 each; each row's AOV equals its revenue ÷ order count.
2. Sum the per-channel revenue and compare against `getRevenueTrend`'s total for the same range → equal.
3. Load as a Basic-plan tenant → card renders, no upgrade prompt.
4. Seed a second tenant with its own orders → none appear (RLS isolation).

**Issues:** #32 (aggregations), #35 (page)

---

### Story 2 — Owner sees advanced sales breakdowns

**User story**
As an **owner**, I want revenue broken down by branch, cashier and payment method, so that I can see which branch is carrying the month, who is ringing the most, and how much of my take is cash.

**Detailed flow**
1. Amira clicks **Sales** in the analytics sub-nav.
2. The page shows three breakdowns: by branch, by cashier, by payment method — each a chart plus a table.
3. Amira notes one branch is well ahead and uses it for a staffing conversation.

**Edge cases & error states**
- Single-branch tenant → the branch breakdown shows one row; cashier and payment-method sections still render
- Web orders have no cashier → they appear in a clearly labelled "Online / no cashier" bucket, **not** a blank row
- Tenant on Basic or Pro → upgrade prompt instead of data; base analytics page unaffected

**Acceptance criteria**
1. User sees revenue and order count grouped by branch, by cashier, and by payment method.
2. Web orders appear in a labelled "Online / no cashier" row rather than a blank one.
3. A Basic or Pro tenant sees an upgrade prompt linking to billing, and no breakdown data.
4. Each of the three sections shows its own empty state independently.
5. A user without `reports:view` is refused before any query runs.

**Test cases**
1. Enterprise tenant with two branches and two cashiers → all three breakdowns populate correctly.
2. Downgrade to Basic → upgrade prompt; `/dashboard/analytics` still works.
3. Payment-method amounts sum to the tendered total for the range.

**Issues:** #32, #36

---

### Story 3 — Owner sees the money-sensitive reports

**User story**
As an **owner**, I want to see tenders and tips, discounts, refunds and voids, and whether the day reconciles, so that I can sign off on the day's take and spot shrinkage.

**Detailed flow**
1. At 11pm, Amira opens **Analytics → Financial**.
2. They see: tenders by method with tips; discounts by reason and by cashier; refunds and voids; the daily reconciliation summary.
3. A spike in voids on one till stands out, and Amira investigates.

**Edge cases & error states**
- Reconciliation source data does not exist yet (Spec 7 unshipped) → that section shows "not available yet"; the other three still render
- Refunds do not exist yet (Spec 3 unshipped) → the refunds sub-section is **hidden**, and must **never** render as "0 refunds"
- Tenant on Basic or Pro → upgrade prompt

**Acceptance criteria**
1. User sees tenders by method, total tips, cash tendered and cash change.
2. User sees discounts totalled by reason code and by cashier.
3. User sees voids by type with counts and amounts.
4. Where a source spec has not shipped, that section states it is unavailable — a zero is **never** shown in place of missing capability.
5. Sections degrade independently; one unavailable source does not blank the page.

**Test cases**
1. Ring a POS sale with a discount and a void → both appear with correct reason codes and attribution.
2. Confirm the refunds sub-section is hidden, not zeroed, while Spec 3 is unshipped.
3. Confirm reconciliation shows its own empty state while the other three sections render.

**Issues:** #32, #33, #37

---

### Story 4 — Manager without financial access is genuinely denied

**User story**
As an **owner**, I want to give my shift manager operational reporting without showing them the day's take, so that I can delegate reporting without exposing revenue.

**Detailed flow**
1. Amira revokes `reports:financial` from Karim's role.
2. Karim signs in and opens **Analytics**. The overview and Sales pages work as before.
3. Karim clicks **Financial** and sees a clear "no access" message.
4. Karim opens browser devtools and inspects the response. **No financial figure is present anywhere in it.**

**Edge cases & error states**
- Karim navigates directly to the financial URL → same denial, no data
- Karim retains `reports:view`, so operational reports keep working

**Acceptance criteria**
1. A user with `reports:view` but without `reports:financial` sees a "no access" state on the financial page.
2. The response body contains **no financial figures** — the queries never execute. This is server-side omission, not CSS hiding.
3. The permission check runs **before** any aggregation call.
4. The same user's access to operational reports is unaffected.

**Test cases**
1. Assert on the rendered response body for a user without `reports:financial` — no tender, tip, refund or reconciliation values present.
2. Confirm operational pages still render for that user.
3. Confirm direct URL navigation is denied identically to nav-driven access.

**Issues:** #29, #37

---

### Story 5 — Tenant on a lower plan is prompted to upgrade

**User story**
As a **tenant on Basic or Pro**, I want to understand what the advanced reports offer and how to get them, so that I can decide whether to upgrade.

**Detailed flow**
1. A Basic-plan owner opens **Analytics** and sees the base page including Sales by channel.
2. They click **Sales**, **Financial**, **Inventory** or **Purchasing**.
3. Each shows a card: "Advanced reports are on the Enterprise plan", linking to billing.

**Edge cases & error states**
- Base analytics must keep working — the upgrade prompt replaces the advanced page, not the whole feature
- POS X/Z reports must keep working — they are never entitlement-gated

**Acceptance criteria**
1. Every advanced page shows an upgrade prompt on Basic and Pro, with a link to `/dashboard/settings/billing`.
2. `/dashboard/analytics` and the Sales-by-channel card still render for those tenants.
3. POS X/Z reports work on every plan.
4. On Enterprise, every advanced page returns data.

**Test cases**
1. Basic tenant → four upgrade prompts, base page intact, POS reports intact.
2. Upgrade to Enterprise → all four pages return data with no code change.
3. Confirm an error other than "feature unavailable" is not swallowed by the entitlement check.

**Issues:** #29, #36, #37, #38

---

### Story 6 — Owner sees inventory and purchasing reports as they become available

**User story**
As an **owner**, I want stock valuation, wastage and supplier spend, so that I can control my largest variable cost — and until that data exists, I want to be told so rather than shown a misleading zero.

**Detailed flow**
1. Amira opens **Analytics → Inventory**.
2. Each section reads "Not available yet — arrives with Inventory (Spec 8)".
3. The page loads cleanly; nothing is broken.
4. When Spec 8 later ships, the same page shows real valuation, consumption, wastage, count variance and low stock — with no change to the reporting layer.

**Edge cases & error states**
- Spec 8 ships before Spec 9 → inventory populates while purchasing still shows its own message; the two degrade independently
- No source table exists → **must not** raise a database error

**Acceptance criteria**
1. Both pages render without error while their source tables do not exist.
2. Each section carries its own message naming the spec it waits on.
3. The two pages degrade independently.
4. Neither page checks `reports:financial` — these are operational and stay visible to a manager without it.
5. When source tables appear, reports populate with no signature change.

**Test cases**
1. Load both pages against the current database → clean render, seven named empty states, no 500, no console error.
2. Confirm no `relation does not exist` is raised under any condition.
3. Confirm a manager without `reports:financial` can still view both pages.

**Issues:** #30, #34, #38

---

### Story 7 — Cashier checks the till mid-shift

**User story**
As a **cashier**, I want to see where the drawer stands without closing my shift, so that I can catch a miscount while it is still fixable.

**Detailed flow**
1. Three hours into a shift, Nour taps **Reports → X report** on the POS.
2. They see gross sales so far, tenders by method, tips, discounts and voids, per-cashier sales, and expected drawer cash.
3. Twenty minutes later Nour pulls it again. Nothing about pulling it changed any figure.

**Edge cases & error states**
- No open shift → a plain informational message, **not** an error
- Nour cannot see another till's or branch's numbers
- Works on every plan — never entitlement-gated

**Acceptance criteria**
1. Cashier sees gross sales, tender breakdown, tips, discounts, voids, per-cashier sales and expected drawer cash for the open shift.
2. The report is **repeatable and non-resetting** — pulling it twice returns identical figures and changes no state.
3. The screen states it is a snapshot that changes nothing.
4. Reads are scoped to the cashier's own device and branch.
5. With no open shift, an informational state shows — not an error.
6. `expectedDrawerCash` = opening float + cash tendered − cash change.

**Test cases**
1. Ring a cash sale of 100 tendered 120 → expected drawer cash is 80.
2. Call the report twice → deeply equal output.
3. Attempt a request with a device token from another tenant → rejected.
4. Confirm a web order in the same tenant does **not** appear in the POS report.

**Issues:** #39, #40, #41

---

### Story 8 — Cashier closes the shift with a Z report

**User story**
As a **cashier**, I want a report at shift close that ties my drawer to what the system recorded, so that there is a record the shift reconciled and I am not blamed for a variance I did not cause.

**Detailed flow**
1. At end of shift Nour opens **Reports → Z report**.
2. They see the shift's totals presented as the close.
3. Once Spec 2's drawer close ships, the report also shows counted versus expected and the over/short.
4. Today, the over/short block reads "arrives with Shifts (Spec 2)".

**Edge cases & error states**
- Shift infrastructure not yet shipped → falls back to the day window with over/short unavailable, **not** zero
- A shift that balanced exactly must look different from one where the feature is missing
- Re-opening a generated Z report returns the frozen snapshot; it does not recompute

**Acceptance criteria**
1. Cashier sees the shift's gross sales, tenders, tips, discounts, voids, refunds, per-cashier sales and drawer cash.
2. Where drawer-count data exists, counted vs expected and the over/short are shown.
3. Where it does not, the report says so — a `null` over/short is **never** rendered as a zero variance.
4. The report is scoped to one shift once shift infrastructure exists.
5. The X/Z distinction is unmistakable on screen — a cashier must never think pulling an X closed the shift.

**Test cases**
1. With shift tables absent → counted cash and over/short come back unavailable, and the report still renders.
2. Confirm an exactly-balanced shift is visually distinguishable from an unavailable one.
3. Confirm Z totals tie to the sales rung during the window.

**Issues:** #39, #40, #41

---

### Story 9 — Revenue reflects what was actually sold

**User story**
As an **owner**, I want revenue figures to exclude orders that were cancelled or rejected, so that I do not staff or plan against money I never took.

**Detailed flow**
1. Amira takes 40 orders in a day; 4 are rejected for stock-outs and 2 cancelled by customers.
2. Today the dashboard reports revenue including all 6, overstating the take by roughly 15%.
3. After this change, revenue reflects the 34 that stood.
4. The definition is written down where Amira's bookkeeper and the next engineer can both find it.

**Edge cases & error states**
- In-flight orders (pending through out-for-delivery) **are** counted — they are committed demand, and excluding them would make today's figures collapse as they progress
- "Orders by status" must **keep** counting cancelled and rejected — that is its entire purpose
- Peak hours is a demand measure, not a money measure, and is unaffected

**Acceptance criteria**
1. Revenue, top products, average order value and fulfilment split all exclude cancelled and rejected orders.
2. Orders-by-status still counts every status, explicitly asserted so a later refactor does not "helpfully" filter it.
3. A metric-definitions document exists defining revenue, order count, AOV, discount, refund, tender, tip and expected drawer cash — each with formula and status filter.
4. Every new report in this feature applies the same definition.
5. `total` remains the revenue measure, inclusive of VAT, service charge and delivery fee — it is the gross take that ties to a drawer and a payout.

**Test cases**
1. Fixture with one completed, one cancelled and one rejected order → revenue equals only the completed order; order count is 1.
2. Same fixture → orders-by-status returns all three.
3. AOV excludes them from both the current and the prior comparison window, so the delta is not skewed.

**Issues:** #31

---

## 6. UI / UX Requirements

**Screen states** — every report section handles four independently:
- **Loading** — follow existing dashboard and POS conventions; do not invent new patterns
- **Empty (no data)** — "No orders in this period". The capability exists; nothing happened.
- **Unavailable (no capability)** — "Not available yet — arrives with [Spec name]". **Distinct from empty.** This distinction is a hard requirement, not a nicety: showing "0 wastage" to an owner who threw away a crate invites a decision based on fiction.
- **Blocked** — either "Advanced reports are on the Enterprise plan" (entitlement) or "You do not have access to financial reports" (permission)

**Error messages**
- Entitlement blocked: *"Advanced reports are on the Enterprise plan"* + link to `/dashboard/settings/billing`
- Permission blocked: a plain no-access state — no figures, no hint at values
- Unavailable source: *"Arrives with Inventory (Spec 8)"* / *"(Spec 9)"* / *"(Spec 7)"* / *"(Spec 3)"* / *"(Spec 2)"*
- POS, no open shift: a plain informational message, never an error

**Interactions**
- Range selector: 7 / 30 / 90 days via `?range=`, default 30, plain links and no client state — matching the existing page
- Sub-nav preserves the active range when switching between report pages
- Reports are read-only — no mutations, so no confirmation dialogs or toasts

**POS-specific**
- Touch-first: large tap targets, high contrast, no hover-dependent information, no small numbers
- **X versus Z must be unmistakable.** X states it is a repeatable snapshot that changes nothing; Z reads as the close.

**Design status:** ⚠️ **No Figma exists** for any of the four dashboard pages or the two POS screens. Layout follows existing conventions. **Confirm with design before merge** — this is the largest open risk in the feature.

## 7. Data & Schema Changes

**New tables:** none required. This is a reading layer over tables other specs own.

**New fields:** none.

**Modified fields:** none.

**New permissions** (application-level, not schema): `reports:view`, `reports:financial`.

**New API endpoints:**
- `GET /api/pos/v1/reports/x` — device Bearer + `X-POS-Cashier`, returns the X report
- `GET /api/pos/v1/reports/z?shiftId=` — same auth, returns the Z report

**Modified endpoints:** none. Dashboard reports are server components, not API routes.

**New IPC bridge methods:** `window.pos.xReport()`, `window.pos.zReport(shiftId?)`.

**Deferred schema** (not in this release): `daily_sales_rollup` and `daily_inventory_rollup` — pure caches, tenant-scoped with FORCE RLS, built only if a real performance problem is observed.

**Tables read** (owned elsewhere): `orders`, `order_items`, `order_payments`, `pos_adjustment_events`, `branches`, `users` (exist today); `refunds`, `reconciliation_runs`, `reconciliation_exceptions`, `settlement_batches`, `stock_ledger`, `inventory_lots`, `inventory_items`, `stock_counts`, `stock_count_lines`, `storage_locations`, `purchase_orders`, `po_receipts`, `po_receipt_lines`, `suppliers`, `pos_shifts`, `cash_counts` (do not exist yet — dependency-guarded).

## 8. Technical Notes

**Cross-channel is a query, not an integration.** `orders.channel` (`web`|`pos`) already distinguishes the two on one table. A combined report ignores it; a sliced one groups by it. There is no ETL and no second data source. The parity invariant — combined revenue equals the sum of per-channel revenue — is the test that proves it.

**Existing code this extends.** `src/server/analytics/service.ts` holds the six shipped aggregations, each wrapped in `withTenant(tenantId, tx => …)` so RLS applies. New aggregations follow the same shape. The plan says to append to that file; **the issues instead split them into `src/server/analytics/reports/{sales,financial,inventory}.ts` re-exported from `service.ts`**, so three engineers can work in parallel without conflicting. Platform analytics in `platform.ts` are cross-tenant and out of scope.

**Building ahead of dependencies.** This feature is Spec 10 and depends on Specs 2, 3, 6, 7, 8 and 9. Most of those tables do not exist; Spec 6 and Spec 7's settlement layer are PARKED. Rather than block, every read of a not-yet-shipped table is guarded by `tableExists()` (`SELECT to_regclass('public.<name>')`), which returns `NULL` rather than throwing and does not poison the transaction. Guarded reports return empty and hide their section today, and light up with **no signature change** when their spec migrates. **Several issues therefore ship as dormant, correct-shape stubs. That is by design.**

**Timezone.** All day-bucketing uses `AT TIME ZONE <tenant.timezone>`, as the existing aggregations do, so a 01:00 sale lands on the correct business day.

**POS scoping.** `requirePosCashier` resolves `{ deviceId, tenantId, branchId, cashierUserId, permissions }` and is the existing guard used by `/api/pos/v1/sales`. The report routes mirror it exactly — a cashier whose tenant does not match the device's is rejected before any query runs.

**Performance.** On-the-fly aggregation is the shipped strategy; a 365-day live query is acceptable. Rollups are the named, deferred escape hatch.

**Known defect being fixed.** `getRevenueTrend` and three sibling aggregations have no order-status filter, so cancelled and rejected orders count as revenue. Fixed in Story 9 / issue #31, ahead of the new aggregations so they inherit a decision rather than an accident.

## 9. Platform-Specific Rules

| | Web dashboard | POS (Electron) |
|---|---|---|
| **Audience** | Owner, Manager | Cashier, Manager |
| **Entitlement** | Advanced reports require `advanced_analytics` | **Never** entitlement-gated |
| **Permission** | `reports:view`, plus `reports:financial` for money reports | `pos:sell` and being signed in |
| **Scope** | Whole tenant | Signed-in device + branch only |
| **Rendering** | Server components, Recharts client boundary | React in the Electron renderer — **no** dashboard components, no Recharts |
| **Transport** | Direct server-side data access | IPC bridge → HTTP route with device Bearer + cashier header |

**Accessibility:** dashboard reports must not convey information by colour alone — charts need labels and tables. POS screens must be legible on a small, often glare-affected till screen at arm's length.

## 10. Linked Issues / PRDs

**Parent:** [PRD-001 — ServeOS](prd-high-serveos.md)

**Epic:** [#28 — Spec 10: Cross-Channel Reporting](https://github.com/Ai-NativeLab/ServeOs/issues/28)

| Story | Issues |
|---|---|
| 1 — Sales by channel | #32, #35 |
| 2 — Advanced sales breakdowns | #32, #36 |
| 3 — Financial reports | #32, #33, #37 |
| 4 — Financial access denied server-side | #29, #37 |
| 5 — Upgrade prompt on lower plans | #29, #36, #37, #38 |
| 6 — Inventory & purchasing | #30, #34, #38 |
| 7 — POS X report | #39, #40, #41 |
| 8 — POS Z report | #39, #40, #41 |
| 9 — Revenue excludes cancelled/rejected | #31 |
| *(all — verification)* | #42 |
| *(deferred)* | #43 |

**Technical documents:**
- Spec: `docs/ailab/specs/2026-07-24-cross-channel-reporting-design.md`
- Plan: `docs/ailab/plans/2026-07-24-cross-channel-reporting.md`
- Roadmap: `docs/ROADMAP.md` — decision D6
- Metric definitions: `docs/ailab/specs/reporting-metrics.md` *(produced by #31)*

**Upstream specs this reads from:** Spec 2 (Shifts & Cash Drawer, in flight), Spec 3 (Refunds), Spec 6 (Payments, PARKED), Spec 7 (Reconciliation, partially PARKED), Spec 8 (Inventory), Spec 9 (Suppliers & Purchasing).

## 11. Open Questions

1. **Design ownership** — who produces Figma for four dashboard pages and two POS screens, and by when? Currently the largest risk.
2. **Net-of-VAT revenue** — Story 9 locks `total` (gross) as the revenue measure. Does the owner also want a net-of-VAT measure? This gains weight with Saudi in scope and a second VAT regime.
3. **Saudi reporting implications** — PRD-001 confirms SA is in scope this year. Do SA tenants need different tax breakdowns in these reports?
4. **Empty vs unavailable, after Specs 8/9 ship** — once source tables exist, an empty result means "no stock movements", but the copy will still read "arrives with Spec 8". Accepted for now; revisit when Spec 8 lands.
5. **Z report persistence** — the spec says a Z report is frozen and immutable at close, but persisting it is owned by Spec 2's close transaction. Confirm Spec 2 covers this, or it falls between the two.
