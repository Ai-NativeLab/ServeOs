# ServeOS — Core POS & Operations Roadmap

**Date:** 2026-07-24
**Status:** Draft — pending review
**Owner:** Platform / AI-NATIVE-LAB
**Scope:** The full sequence of specs that take ServeOS from "a register that takes sales" to a full operations platform: tamper-evident auditing, online payments, transaction reconciliation, inventory with recipe-level deduction, purchasing, and cross-channel reporting — across **both** the POS (Electron) and the online storefront.

This is the first cross-namespace index in `docs/`. Every feature still gets its own paired
design spec (`docs/<ns>/specs/YYYY-MM-DD-<slug>-design.md`) and implementation plan
(`docs/<ns>/plans/YYYY-MM-DD-<slug>.md`). This file is the map that sequences them and
locks the decisions they share. **When a spec and this file disagree on a name or a
sequence number, this file wins** until the spec is approved and updates it.

---

## Where we are today (ground truth)

- **Money math** lives in exactly one module — `src/lib/order-totals.ts` — and is persisted as `numeric` strings via `money(n)` (`src/server/ordering/service.ts:55`). Both the Next server and the Electron POS import it.
- **Tenancy** is enforced by Postgres RLS through `withTenant(tenantId, tx => …)` (`src/db/with-tenant.ts`). Control-plane tables (`users`, `pos_devices`, `pos_order_receipts`, platform `audit_logs`, …) intentionally have no RLS.
- **Orders** — one `placeOrder` (`src/server/ordering/service.ts:59`) serves both channels; the POS wraps it with `recordSale` (`src/server/pos/record-sale.ts:51`) which adds tenders (`order_payments`), an append-only discount/void trail (`pos_adjustment_events`), and device-level idempotency (`pos_order_receipts`).
- **Payments** — **there is no gateway.** `payment_method` is a single-value enum (`cash`). POS tenders record `cash | card | other` but nothing is processed; online is cash-on-collection with a manual `markPaid`.
- **Stock** — a single global **integer** on `products.stockQuantity` / `product_variants.stockQuantity`, decremented by a guarded `UPDATE` inside `placeOrder`, gated on the vertical capability `stockTracking` (restaurant **off**; retail/pharmacy/timber **on**). No lots, no per-branch quantity, no stock ledger, **no unit of measure**, no recipes.
- **Audit** — only the platform `audit_logs` table, written **only** by super-admin actions. There is **no tenant-side audit trail** and **no logger/observability** anywhere (2 `console.error` lines in the whole codebase).
- **Reporting** — a tenant analytics service (`src/server/analytics/service.ts`, 6 on-the-fly aggregations) surfaced only on the web dashboard, gated by `menu:manage`. The `advanced_analytics` plan flag exists but is **not enforced**. Nothing analytical is available on the POS.
- **Comms** — no email / SMS / WhatsApp / push infrastructure exists.

---

## Decisions (locked)

These come from the product owner and hold across every spec below.

| # | Decision | Choice |
|---|----------|--------|
| D1 | Audit log | **Append-only, hash-chained (tamper-evident), device/session fingerprinted, and SYSTEM-WIDE.** Every action carries `prev_hash`/`entry_hash` plus a `{deviceId, appVersion, ip, userAgent}` fingerprint. Covers **all mutations + auth events (login/logout/failed) + sensitive reads/exports** (customer PII, financial/reconciliation reports, cross-cashier sales, data exports — not ordinary reads) across **every domain** and **all actor types** (staff, manager, owner, customer, system). A **coverage guardrail test** fails CI if a mutating service/route doesn't emit. The existing platform super-admin `audit_logs` table stays **separate**. |
| D2 | Reconciliation scope | **Daily close + cash drawer + external settlement.** Ties every order to its tenders across POS + online, reconciles counted cash per shift, and matches a gateway's settlement/payout to recorded tenders. |
| D3 | Payment gateway | **Paymob first**, behind a `PaymentGateway` provider interface (mirrors the existing `BillingProvider`). EG/EGP-native. Tap, Checkout.com, Fawry, Stripe are future providers on the same interface. **⏸ PARKED 2026-07-24 — owner deciding separately; implementation of Specs 6/7 settlement held until a provider is chosen.** |
| D4 | Inventory depth | **Recipe/BOM auto-deduction.** Selling a dish deducts its ingredient lots FIFO; retail items deduct finished-goods stock. Requires a stock **ledger**, **unit-of-measure**, **per-branch storage locations**, and fractional quantities. |
| D5 | Suppliers & purchasing | **PO tracking + receiving + send-to-supplier.** Full PO lifecycle, receiving against PO increments lots, PO-vs-received-vs-invoice variance, and the PO can be emailed to the supplier from the system. |
| D6 | Reporting | **Cross-channel, dual-surface.** Manager reports on the web dashboard span POS + online; the POS gets operational **X / Z reports**. Gated by a new `reports:view` permission and the (now-enforced) `advanced_analytics` entitlement. |
| D7 | Email / notifications provider | **Resend first**, behind an `EmailProvider` interface. Free tier (3k/mo, 100/day) covers POs + alerts; Brevo (free-forever, SMTP relay) and Amazon SES (cheapest at scale) are alternatives on the same interface. No self-hosted SMTP. Requires a verified sending domain + DNS (SPF/DKIM/DMARC). Chosen 2026-07-24. |
| D8 | Fiscal compliance | **ETA e-Invoicing & e-Receipts is IN SCOPE (Spec 11).** POS + online sales submit to the Egyptian Tax Authority; receipts carry the ETA UUID + QR code; refunds issue credit notes; products carry EGS/GS1 tax codes. Built behind a `FiscalProvider` interface so other tax regimes can be added. Exact ETA API/mandate details verified against current ETA docs during speccing. Added 2026-07-24. |
| D9 | Restaurant stock mode | **Both, per product.** Dishes default to made-to-order (recipe/BOM deduction); packaged/retail items use finished-goods stock. `product_inventory_links.kind` selects per product. Resolves the former open question #5. |

### Consequences of the locked decisions (things we must build that don't exist yet)

- **A payment gateway integration** (D2, D3) — nothing to reconcile against otherwise.
- **An outbound email / notification layer** (D5 send-to-supplier, D4 low-stock alerts) — no comms infra exists today.
- **A stock ledger + UoM + per-branch storage + the `inventory` capability turned on for restaurants** (D4) — the flat integer counter cannot express ingredient deduction.
- **Enforcement of the dormant `advanced_analytics` entitlement** (D6).

---

## The full sequence

`✅` done · `▣` planned by team, not yet written · `☐` new (this roadmap)

| Spec | Title | State | Depends on | Requested here |
|------|-------|-------|------------|----------------|
| 1 | Sale & Tender | ✅ done | — | — |
| 2 | Shifts & Cash Drawer | ☐ spec drafting | 1 | prerequisite for reconciliation |
| 3 | Refunds & Sales History | ☐ spec drafting | 1 | prerequisite for reconciliation + reporting |
| 4 | **Audit & Fingerprint Log** | ☐ spec written | 1 | **logging** |
| 5 | **Notifications & Outbound Email** | ☐ spec drafting | 1 | prerequisite for alerts + send-PO |
| 6 | **Payments & Gateway** (Paymob) | ☐ spec written · ⏸ impl PARKED | 1 | prerequisite for reconciliation |
| 7 | **Transaction Reconciliation** | ☐ spec written · ⏸ settlement layer PARKED | 2, 3, 6 | **reconciliation** |
| 8 | **Inventory Core + Recipes/BOM** | ✅ Part A/B built (2026-08-04) · Part C/D → Spec 9 | 1 | **inventory** |
| 9 | **Suppliers & Purchasing** | ☐ spec written | 8, 5 | **inventory / suppliers** |
| 10 | **Cross-Channel Reporting** | ☐ spec written | 3, 4, 6, 7, 8, 9 | **reporting** |
| 11 | **Fiscal Compliance — ETA e-Invoicing & e-Receipts** | ☐ spec drafting | 1, 3 | **e-invoicing (promoted from backlog)** |

### Dependency graph

```
Spec 1  Sale & Tender  ✅
  │
  ├── Spec 2  Shifts & Cash Drawer ▣ ──┐
  ├── Spec 3  Refunds & Sales Hist ▣ ──┤
  ├── Spec 4  Audit & Fingerprint  ☐   │
  ├── Spec 5  Notifications/Email  ☐ ──┐│
  ├── Spec 6  Payments & Gateway   ☐ ──┼┴──► Spec 7  Reconciliation ☐
  │                                     │
  └── Spec 8  Inventory + Recipes  ☐ ──┴──► Spec 9  Suppliers & Purchasing ☐
                                                     │
      All of the above ─────────────────────────────┴──► Spec 10  Cross-Channel Reporting ☐
```

**Parallelizable now:** Specs 4 (Audit), 5 (Notifications), 8 (Inventory core) have no dependency on the unwritten 2/3 and can start immediately. Spec 6 (Payments) can start once a gateway is signed off. Spec 7 (Reconciliation) is the capstone that waits on 2, 3, 6. Spec 11 (ETA fiscal) depends only on Spec 1 (plus Spec 3 for credit notes) and is compliance-critical, so it can start early.

---

## Canonical names (authoritative for all specs)

**New tables** — all tenant-scoped with FORCE RLS unless noted.

| Area | Tables |
|------|--------|
| Shifts (2) | `pos_shifts`, `cash_counts` (opening/closing count + variance), `cash_movements` (pay-in/out, drops, no-sale) |
| Refunds (3) | `refunds`, `refund_lines`, `refund_payments` (refund tenders — money out) |
| Audit (4) | `audit_events` (append-only, RLS), `audit_chain_heads` (one row/tenant, chain head + seq) |
| Notifications (5) | `notifications`, `notification_outbox` (email send queue), `email_events` (provider webhooks) |
| Payments (6) | extend `order_payments` (`gatewayProvider`, `processorTxnId`, `status`); `payment_gateway_events` (raw webhook + idempotency), `settlement_batches`, `settlement_lines` |
| Reconciliation (7) | `reconciliation_runs`, `reconciliation_exceptions` (cash variance draws on Spec 2's `cash_counts`) |
| Inventory (8) | `inventory_items`, `storage_locations` (per branch), `inventory_lots`, `stock_ledger` (append-only), `recipes`, `recipe_components`, `product_inventory_links`, `stock_counts`, `stock_count_lines` |
| Purchasing (9) | `suppliers`, `purchase_orders`, `purchase_order_lines`, `po_receipts`, `po_receipt_lines` |
| Reporting (10) | *optional* rollups `daily_sales_rollup`, `daily_inventory_rollup` |
| Fiscal (11) | `eta_submissions` (invoice/receipt/credit-note submissions + UUID/QR/status), `product_tax_codes` (EGS/GS1 code + tax type per product), `eta_tenant_config` (registration + encrypted credentials) |

**New permissions** (`src/server/rbac/permissions.ts`):
`audit:view`, `payments:manage`, `reconciliation:manage`, `inventory:view`, `inventory:manage`, `inventory:count`, `purchasing:manage`, `suppliers:manage`, `reports:view`, `reports:financial`.
Default mapping — **owner:** all; **manager:** all except `reports:financial` is owner+manager, `reconciliation:manage` owner+manager; **staff:** `inventory:view`, `inventory:count` only.

**New vertical capabilities** (`src/server/verticals/registry.ts`):
`inventory` (lots + ledger; replaces the legacy flat `stockTracking` — on for retail/pharmacy/timber **and** restaurant), `recipes` (restaurant only). `stockTracking` kept as a legacy alias through the migration window.

**New provider interfaces** (mirroring `BillingProvider`):
`PaymentGateway` (default provider: `PaymabGateway`), `EmailProvider` / `NotificationProvider`.

**New money/units rule:** inventory quantities are `numeric` (fractional) with an explicit unit of measure; **sellable order-line quantities stay integer**. All monetary values keep the `money(n)` numeric-string convention.

---

## Architecture notes that cut across specs

### Auditing (Spec 4)
- Every mutating write emits `recordAuditEvent(ctx, {...})` **inside the same transaction** as the action, so the audit row is atomic with the change it records.
- The chain is **per-tenant**: `audit_chain_heads` holds `(tenantId, seq, headHash)`; append takes `pg_advisory_xact_lock(hashtext(tenantId))` (the same lock pattern `placeOrder` already uses for order numbers), computes `entry_hash = sha256(canonical(prev_hash, seq, tenant, actor, action, entity, metadata, createdAt))`, and advances the head.
- **Tamper-evidence** = an append-only DB trigger that raises on `UPDATE`/`DELETE` of `audit_events`, plus a periodic chain **verifier** that walks each tenant's chain and reports breaks.
- **Fingerprint** = `{deviceId, appVersion, ip, userAgent}` captured at the API boundary and threaded through `ctx`. POS already sends a device Bearer token + `X-POS-Cashier`; we add an `X-POS-App-Version` header and store a **hash** of the device token, never the token.
- The existing platform `audit_logs` stays for super-admin actions; `audit_events` is the tenant operational + tamper-evident log.

### Payments & reconciliation (Specs 6 → 7)
- **`PaymentGateway` interface**: `createPayment`, `capture`, `refund`, `parseWebhook`, `fetchSettlement`. Paymob is the first implementation.
- **Online prepayment**: checkout creates a gateway payment → embedded/redirect → **webhook confirms** → write an `order_payments` row (method `card`/`wallet`) + flip `paymentStatus`. `payment_gateway_events` dedupes webhooks.
- **Reconciliation has three layers**: (a) *order↔tender integrity* — every order's tenders minus change tie to its total, no orphans, unique `clientPaymentId`; (b) *cash drawer* — expected vs counted per shift (needs Spec 2), variance flagged; (c) *external settlement* — match the gateway's payout/settlement lines to `order_payments` by `processorTxnId`, surface matched / unmatched / fee lines. Daily close aggregates all three across channels in tenant timezone and can be hash-anchored into the audit chain.

### Inventory, recipes & purchasing (Specs 8 → 9)
- **The flat integer counter is replaced by a ledger.** `stock_ledger` is append-only (receive, sale_deduction, adjustment, count, transfer, waste, refund_restock, production); `inventory_lots` cache remaining quantity for FIFO/expiry; on-hand is derivable from the ledger.
- **`placeOrder`'s stock step is rewired**: for each sold line, resolve `product_inventory_links` → if a **recipe**, deduct each component (scaled by sold qty) FIFO from the branch's kitchen location; if **finished-goods**, deduct the linked item's lot at the branch's retail location. The existing guarded-update concurrency semantics are preserved via lot-remaining checks.
- **Restaurants can't be blocked at the till** — a per-tenant `allowNegativeStock` policy lets kitchens oversell ingredients (deduction still recorded, on-hand goes negative and alerts) rather than failing a sale.
- **Per-branch stock** arrives via `storage_locations` (branchId) — fixes today's single-global-count limitation.
- **Migration**: existing `products.stockQuantity` / `product_variants.stockQuantity` are seeded into `inventory_items` + opening-balance ledger entries; retail continuity preserved.

**Built 2026-08-04 (Part A/B) — three things later specs must know:**
- **There is ONE platform UoM enum**, `unit_of_measure` in `src/server/catalog/uom.ts` (decision T1, shipped by P4). Spec 8 imports it rather than declaring `inventory_uom`. It is a **superset**: it also carries P4's sellable `m`/`m2`/`bf`, which are not stockable. A pg enum cannot express the subset, so `assertInventoryUom` in `src/server/inventory/uom.ts` is the boundary — **any new code writing a UoM-bearing inventory row must pass through it.**
- **Spec 10's inventory reports were written against guessed column names and all of them were wrong** (`remaining_qty`/`qty_remaining`, `name`/`name_en`, `quantity`/`qty`, `movement_type`/`type`, `expected_qty`/`system_qty`, `stock_count_id`/`count_id`, `created_at`/`started_at`). Corrected when the tables landed. The lesson for Specs 9/11: a `tableExists` guard hides a schema mismatch until the table appears, so forward-written SQL needs re-checking against the real DDL on the day it goes live.
- **`getLowStock` is guarded on `reorder_rules`, not on the inventory tables**, because the reorder point is per item per location in that table (Part D) — deliberately not a column on `inventory_items`. **Spec 9 must verify that query against the real table when it builds `reorder_rules`**; it has never executed.
- **Recipe authoring is an API this spec added, not one it specified.** The design doc's API section lists only items / on-hand / adjustments / transfers / counts, so a BOM could originally only be created by direct DB writes. `/api/inventory/recipes`, `/recipes/[id]` and `/product-links` fill that gap; Spec 9's purchasing surface should assume they exist.
- **Expired lots are excluded from FIFO**, so an item's on-hand can legitimately exceed what is sellable. Any report that treats on-hand as available stock (Spec 10 valuation is fine; a future "what can we sell" view is not) must subtract expired lots itself.
- **Cut-to-size policy is fixed, not configurable**: `KERF_MM = 3` and `MIN_OFFCUT_MM = 300` are constants in the inventory service. Fine for launch; a real yard with a different blade or scrap threshold needs them promoted to tenant settings before the numbers start lying.
- **Purchasing**: `purchase_orders` lifecycle draft → sent → partially_received → received → closed; receiving writes lots + ledger rows; PO-vs-received-vs-invoice variance is a reconciliation report. **Send-to-supplier** renders the PO and emails it via the Spec 5 layer.
- **Low-stock alerts**: reorder point/qty per item per location; a scheduled check raises `notifications` and can pre-fill a draft PO.

### Reporting (Spec 10)
- **Web dashboard (managers):** sales by channel / branch / cashier / payment method, refunds & voids, discounts, tenders & tips, daily reconciliation summary, inventory (on-hand valuation, consumption, wastage, count variance, low-stock), purchasing (spend by supplier, received vs invoiced).
- **POS (Electron):** **X report** (mid-shift, non-resetting) and **Z report** (shift close, ties to Spec 2), per-cashier sales, drawer count — served through the POS bridge, scoped to device/branch.
- **Entitlement**: enforce `advanced_analytics` for advanced reports; base sales stay in the base plan. New `reports:view` (owner+manager) and `reports:financial` (owner+manager) permissions.
- **Performance**: current on-the-fly aggregation is fine for MVP; optional nightly rollup tables are the escape hatch for long-range cross-channel/inventory reports.
- **Known wart**: several analytics readers run `Promise.all` over queries sharing ONE transaction client (`analytics/service.ts`, `analytics/pos-reports.ts`). node-postgres serializes them anyway and now emits a DeprecationWarning ("client.query when the client is already executing") in test output. The parallelism is illusory — sequential awaits inside the tx are the fix whenever someone next touches those readers.

---

## Future iterations (POS backlog)

Beyond the ten specs above, these are the gaps between ServeOS's POS and a full-featured
restaurant/retail register. Not scheduled — captured now so the data model leaves room
for them (e.g. table/seat ids, terminal ids, customer ids) rather than being retrofitted.

1. **Offline-first resilience** — `apps/pos/electron/_offline/` is parked today. A till must keep selling through an internet drop and sync on reconnect. Highest operational priority; the current online-first model fails hard when the network does.
2. ✅ **PROMOTED to Spec 11 (2026-07-24)** — Egyptian Tax Authority (ETA) e-invoicing / e-receipt. No longer backlog; now a numbered, in-scope spec (see D8). Egypt mandates electronic invoicing/receipts with a signed QR on the receipt; POS + online sales submit to ETA. Exact mandate scope/thresholds verified during speccing.
3. **Dine-in & table management** — the POS is walk-in only (hardcoded "Walk-in", pickup — `record-sale.ts`). Restaurants need a floor plan, table tabs, seat/course assignment, and transfer / merge / split checks. Held tickets (Spec 1) are a partial stand-in.
4. **Kitchen Display System (KDS) + kitchen printing** — no KDS exists; orders sit in the `OrdersQueue` screen. Needs prep timers, station routing, ESC/POS thermal chits, and a bump-bar flow.
5. **Peripheral hardware** — receipt printer (ESC/POS), cash-drawer kick, barcode scanner (retail), weighing scale (sold-by-weight — ties to inventory UoM in Spec 8), customer-facing display.
6. **Loyalty, store credit & gift cards** — customer capture, points, and store credit (also the natural destination for refund-to-credit from Spec 3).
7. **Promotions & combos engine** — rules-based meal deals, BOGO, happy-hour, and coupon codes, beyond Spec 1's manual line/order discounts.
8. **Instant "86" / availability toggle** — mark an item unavailable from the POS in one tap; feeds and is fed by Spec 8 low-stock.
9. **Staff time clock & tip pooling** — clock-in/out and tip-out distribution / labour reporting (Spec 2 covers cash, not labour).
10. **Delivery dispatch** — driver assignment and tracking for delivery orders.

---

## Open questions for the owner

1. **Payment gateway (D3):** ⏸ **PARKED 2026-07-24** — owner deciding separately. Specs 6 (Payments) and 7 (Reconciliation) are written; implementation of the settlement layer is held until a provider is chosen. The cash + integrity reconciliation layers do **not** wait on this.
2. **Email provider (Spec 5):** ✅ **RESOLVED** — **Resend**, behind the `EmailProvider` interface (see D7). Needs a verified sending domain + DNS records from the owner (details below).
3. **Shifts & Refunds (Specs 2, 3):** ✅ **RESOLVED** — this roadmap absorbs and specs them (drafted 2026-07-24) so reconciliation is unblocked.
4. **Integrated POS card terminals** vs. "record-only" card tenders — ⏸ parked alongside #1; specs default to record-only, and integrated terminals will come with the chosen gateway/hardware vendor.
5. ✅ **RESOLVED (2026-07-24)** — restaurant stock mode is **both, per product** (see D9): dishes = made-to-order (recipe/BOM), packaged/retail items = finished-goods, selected by `product_inventory_links.kind`.
