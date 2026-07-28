# ServeOS — Refunds & Sales History Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** Spec 3 of the core-POS roadmap (`docs/ROADMAP.md`). It owns two things that Spec 1 left open: **refunds** — money returned *after* a completed sale — and **sales history** — the operational surface that lets a cashier find a past sale, reprint its receipt, and start a refund from it, on both the POS (Electron) and the web dashboard. It is a **prerequisite for Spec 7 — Transaction Reconciliation** (refund tenders must net against gross takings) and **Spec 10 — Cross-Channel Reporting** (the refunds-&-voids report). It builds directly on **Spec 1 — Sale & Tender** (`order_payments`, `pos_adjustment_events`, `recordSale`, `resolveAuthorizer`, `REASON_CODES`) and depends on nothing unwritten; where it touches **Spec 2** (shifts), **Spec 4** (audit), **Spec 6** (gateway), or **Spec 8** (stock ledger) it names that surface as an input and degrades gracefully when it is absent.

## Context

Spec 1 shipped the till. `recordSale` (`src/server/pos/record-sale.ts:51`) wraps `placeOrder`, adds tenders to `order_payments` (positive amounts, `method` `cash | card | other`, an optional free-text `reference`), records an append-only discount/void trail in `pos_adjustment_events` (`src/server/pos/tender-schema.ts`), and guarantees device-level idempotency through `pos_order_receipts` keyed on `clientPaymentId`. Over-limit discounts are gated by `resolveAuthorizer` — a `pos:sell` cashier who exceeds their limit needs a manager to enter credentials, which resolves to an `authorizedByUserId`. Reason strings come from a shared `REASON_CODES` list.

Two capabilities exist today; a third does not:

- **Void** is done — `pos_adjustment_events` carries `line_void` and `order_void` (the `pos_adjustment_type` enum), and cancelling an order restocks it (`restockOrderItems`, `src/server/ordering/service.ts:279-295`).
- **Sales history** barely exists — the web dashboard has an `OrdersTable` (`src/app/dashboard/orders/OrdersTable.tsx`); the POS has **no** way to look up a sale once the receipt prints.
- **Refund** does not exist at all. `orders.paymentStatus` is `unpaid | partially_paid | paid` (`src/server/ordering/schema.ts:10`) — there is no value that means *money went back out*, no table records a return, and the `pos:refund` permission (already present in `src/server/rbac/permissions.ts`, added by Spec 1) has **zero consumers**. This spec is its first.

## Problem

Money leaves a ServeOS sale through three distinct mechanisms, and only one of them is missing — but conflating them is the trap this spec must avoid.

- A **void** cancels a line or a whole order **before money is finalized** — the customer changed their mind at the till, a line was rung twice. It is already modelled (`pos_adjustment_events` `line_void`/`order_void` + the order `cancelled` state + `restockOrderItems`). **This spec does not re-model voids.**
- A **discount** reduces what is owed at sale time — Spec 1, done.
- A **refund** returns money **after a completed, paid sale** — the customer brings back a cold dish an hour later, a retail item is faulty next week. Nothing models this. It is not a void (the sale finalized and tenders settled), and it is not a negative sale (the original order is history, not to be rewritten).

Second, **you cannot refund what you cannot find.** There is no way to search completed sales by date, cashier, order number, phone, or amount; no way to reprint a receipt; and no way to launch a refund from a past sale — on either surface. The dashboard `OrdersTable` lists live orders for fulfilment, not a searchable ledger of finished takings, and the POS drops a sale from view the moment its receipt prints. A refund is almost always initiated *from* a lookup ("customer is here with item X from last Tuesday"), so sales history is not a nice-to-have beside refunds — it is the entry point to them, which is why the two ship as one spec.

## Goal

Own refunds end to end — full and partial, line-level, with per-line restock and one or more refund tenders (money out) — and the sales-history surfaces that drive them, on both the POS and the dashboard. Preserve every Spec 1 invariant: `money(n)` numeric strings (`src/server/ordering/service.ts:55`), RLS tenancy via `withTenant` (`src/db/with-tenant.ts`), `clientRefundId` idempotency mirroring `clientPaymentId`, and the `resolveAuthorizer` manager-grant pattern. Emit the effects the rest of the platform assumes: an extended `payment_status`, a Spec 8 `refund_restock` stock movement, a Spec 4 `refund.issued` audit event, and refund tenders that Spec 7 reads as money **OUT**.

## Void vs Refund (the distinction this spec turns on)

| | **Void** (existing — Spec 1) | **Refund** (new — this spec) |
|---|---|---|
| When | Before money is finalized | After a completed, paid sale |
| Models | `pos_adjustment_events` (`line_void`/`order_void`) + order `cancelled` + `restockOrderItems` | `refunds` / `refund_lines` / `refund_payments` |
| Money | No tender ever settled | Tender settled; money now goes back out (`refund_payments`) |
| Order | May be cancelled outright | Untouched — the original sale stays as history; the refund references it |
| Owner | Spec 1 — **not re-modelled here** | Spec 3 |

A refund never mutates the original order's items or tenders. The order is an immutable record of what was sold and collected; a refund is a *new* record of what was returned against it. This is why refunds get their own tables rather than negative `order_payments` rows: a return has its own actor, authorizer, reason, timestamp, restock decision, and (later) its own shift and audit anchor — none of which belong on a settled sale tender, and all of which reconciliation and reporting need to read independently of the original takings.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| R1 | Void vs refund boundary | A **void** is pre-finalization and stays in `pos_adjustment_events` (Spec 1), **not re-modelled**. A **refund** is post-sale money-out, owned here. Attempting to void a paid order routes to refund; attempting to refund an open/unpaid order routes to void. |
| R2 | Granularity | `kind` = **`full` \| `partial`**. A partial refund is expressed line-by-line via `refund_lines` (each names an `order_item`, a quantity, and an amount). A full refund returns the order's entire net-paid amount. |
| R3 | Authorization | Gated by **`pos:refund`**. Owner + manager hold it; a `pos:sell`-only cashier needs a manager grant through **`resolveAuthorizer`**, resolving to `authorizedByUserId` — **identical to the over-limit discount pattern in `record-sale.ts`.** |
| R4 | Idempotency | **`clientRefundId`, unique per order**, mirroring `clientPaymentId` on tenders. A duplicate submit returns the first refund, never a second. |
| R5 | Restock | Per-line **`restock` boolean**. `restock=true` triggers a Spec 8 **`refund_restock`** `stock_ledger` movement; until Spec 8 lands it falls back to `restockOrderItems` integer add-back. `restock=false` (spoiled/damaged goods) returns money without returning stock. |
| R6 | Money out | `refund_payments` are **money leaving** the business. `order_payments` stays positive-in only; refunds are never written there. Reconciliation (Spec 7) nets `refund_payments` against gross takings. |
| R7 | `store_credit` | A recorded refund `method` but a **stub** — issuing store credit records the intent; a future loyalty/store-credit spec (roadmap POS backlog #6) makes it a redeemable balance. Not a wallet yet. |
| R8 | Money convention | Amounts are `money(n)` numeric strings. **Cumulative refunds against an order can never exceed its net-paid amount** (`Σ order_payments − change − Σ prior refund_payments`). |

## Non-goals (deferred by explicit decision)

- **Voids** — already Spec 1 (`pos_adjustment_events`). Not re-modelled; see the table above.
- **Store-credit / gift-card issuance & redemption** → a future **Loyalty & Store Credit** spec (roadmap POS backlog #6). `store_credit` here is a recorded method, not a spendable balance.
- **Executing a card/online refund through the gateway** (`gateway.refund()`) → **Spec 6** owns the primitive. This spec records the `refund_payment` and, once Spec 6 lands, calls `gateway.refund()`; until then card/online refunds are **record-only** and flagged.
- **The cash-drawer / shift-close math a cash refund affects** → **Spec 2**. We stamp `shiftId`; Spec 2's `expected cash = float + Σ cash tenders − Σ cash refunds` reads it.
- **The tamper-evident audit chain itself** → **Spec 4**. We call `recordAuditEvent`; we do not build the chain.
- **Refunds-&-voids reporting dashboards** → **Spec 10**, which reads `refunds` + `pos_adjustment_events`. This spec produces the rows.

---

## Data model

Three new tables, all tenant-scoped with **FORCE RLS**, plus one enum extension. Amounts are `money(n)` numeric strings throughout. The shape mirrors the Spec 1 sale hierarchy deliberately — `refunds : refund_lines : refund_payments` is the return-side reflection of `orders : order_items : order_payments` — so the same aggregation and RLS patterns apply and nothing new has to be learned to read a refund.

### New: `refunds`

The header of one return against one completed order. One order may accrue many partial refunds over time.

| Column | Notes |
|---|---|
| `id`, `tenantId` | tenant-scoped, FORCE RLS |
| `orderId` | → `orders.id`. The completed sale being refunded (never mutated). |
| `branchId` | → `branches.id`. The branch processing the refund (may equal the order's). |
| `kind` | enum `refund_kind`: `full \| partial` |
| `reasonCode` | reuses Spec 1's shared **`REASON_CODES`** list (spoiled, wrong_item, customer_request, …) |
| `reasonText` | text, nullable — free-text elaboration |
| `totalAmount` | `numeric` (`money`) — `Σ refund_payments.amount`; also `Σ refund_lines.amount` when line-itemised |
| `byUserId` | → `users.id` — the cashier who processed it |
| `authorizedByUserId` | → `users.id`, nullable — set via `resolveAuthorizer` when the processor lacks `pos:refund` (manager grant), exactly as discounts capture their authorizer |
| `shiftId` | → `pos_shifts.id`, **nullable** — Spec 2; null when shifts are absent/off |
| `clientRefundId` | text — device-supplied idempotency key; **unique per `(orderId, clientRefundId)`** |
| `createdAt` | timestamptz |

### New: `refund_lines`

The per-item breakdown of a partial (or itemised full) refund. Enables line-level returns and per-line restock decisions.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `refundId` | `refundId` → `refunds.id` |
| `orderItemId` | → `order_items.id` — the sold line being returned |
| `quantity` | integer — units returned; `≤ (ordered qty − already-refunded qty)` for that item |
| `amount` | `numeric` (`money`) — money returned for this line |
| `restock` | boolean — whether these units return to stock. `true` → `refund_restock` ledger movement (Spec 8); `false` → money back, stock not returned (spoiled/damaged) |

### New: `refund_payments`

The tenders of a refund — money **going out**. The mirror of `order_payments`, opposite direction.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `refundId` | `refundId` → `refunds.id` |
| `method` | enum `refund_method`: `cash \| card \| store_credit \| other`. `store_credit` is a **stub** (R7). |
| `amount` | `numeric` (`money`) — money **OUT**. Stored positive; its direction is implied by the table, so `order_payments` need not carry a sign. |
| `reference` | text, nullable — card/terminal reference or gateway `processorTxnId` (Spec 6) |
| `takenByUserId` | → `users.id` — who handed the money back |
| `createdAt` | timestamptz |

### Effect: extend `payment_status`

`paymentStatusEnum` (`src/server/ordering/schema.ts:10`) grows from `unpaid | partially_paid | paid` to add **`refunded`** and **`partially_refunded`**. After `issueRefund` recomputes an order's net-paid:

- net-paid `> 0` and any refund exists → **`partially_refunded`**
- net-paid `== 0` because refunds returned everything collected → **`refunded`**

The value is derived from the tender/refund math, never set by hand.

## Authorization

- **`pos:refund`** gates issuing a refund. **Owner + manager** hold it by default (already mapped by Spec 1). A **`pos:sell`-only cashier** may still process a refund, but only with a **manager grant via `resolveAuthorizer`** — the manager's credentials are entered at the till, validated to hold `pos:refund`, and captured as `refunds.authorizedByUserId`. This is byte-for-byte the over-limit-discount authorization flow already in `record-sale.ts`; no new authorization primitive is introduced.
- **Reprinting** a receipt and **searching/viewing** sales history require only **`pos:sell`** — a cashier can look up and reprint any sale at their branch, but returning money is the privileged step.
- The dashboard surfaces resolve the tenant from the authenticated web session; the POS resolves it from the device Bearer token + `X-POS-Cashier` (`requirePosCashier`). Both query through `withTenant`, so **RLS scopes every read and write**. `refunds`, `refund_lines`, and `refund_payments` are **FORCE RLS**; cross-tenant access is impossible.

## API

**Service layer** (shared by both surfaces, scoped by `withTenant`):

- `listSales(ctx, { dateRange?, cashierUserId?, orderNumber?, customerPhone?, amount?, branchId?, page })` — search/list **completed** sales. Backs both the POS search and the dashboard Sales History.
- `getSale(ctx, orderId)` — one sale's full detail: items, `order_payments` tenders, `pos_adjustment_events` (discounts/voids), **and its `refunds`** with lines and refund tenders.
- `issueRefund(ctx, { orderId, kind, lines[], payments[], reasonCode, reasonText?, clientRefundId, authorizerCredentials? })` — the core mutation. In **one `withTenant` transaction**: validate against net-paid and per-line remaining qty; resolve the authorizer if the processor lacks `pos:refund`; insert `refunds` + `refund_lines` + `refund_payments`; restock each `restock=true` line; recompute and flip `payment_status`; call `recordAuditEvent(ctx, { action: 'refund.issued', … }, tx)`. Idempotent on `(orderId, clientRefundId)`.
- `reprintReceipt(ctx, orderId)` — re-render the original sale receipt (and, for a refunded order, an accompanying refund slip).

`listSales` returns only orders in a **finalized** state (`completed`, or paid/partially-refunded) — open tickets and voided orders are out of scope for a refund. Results are indexed for the four common lookups: `(tenantId, branchId, placedAt)` for the date scan, plus supporting indexes on `orderNumber` and `customerPhone`; amount search filters on `total`.

**POS routes** (Electron bridge, `requirePosCashier`), under `src/app/api/pos/v1/sales/`:

- `GET  /api/pos/v1/sales` — search (`pos:sell`) → `listSales`.
- `GET  /api/pos/v1/sales/:orderId` — detail (`pos:sell`) → `getSale`.
- `POST /api/pos/v1/sales/:orderId/refund` — issue a refund (`pos:refund`, or `pos:sell` + manager grant) → `issueRefund`.
- `POST /api/pos/v1/sales/:orderId/reprint` — reprint (`pos:sell`) → `reprintReceipt`.

**Surfaces:**

- **POS (Electron):** a new **`SalesHistory.tsx`** screen (POS renderer, alongside the existing `OrdersQueue`) — a search list (date / cashier / order # / phone / amount), a detail pane with **Reprint**, and a **Refund** action that opens a composer: pick lines or full, toggle restock per line, add refund tenders, choose a reason code, and (if unprivileged) capture the manager grant.
- **Web dashboard:** a Sales History view extending `src/app/dashboard/orders/` with the same filters, a detail view that surfaces refunds, and a manager **Refund** action calling `issueRefund` through a server action.

## Architecture — refund against a past sale

```
  POS SalesHistory.tsx / dashboard         search (date, cashier, #, phone, amount)
            │                                        │
            │  select a completed sale               ▼
            │                              listSales / getSale  ──►  withTenant(RLS) ──► orders + order_items
            ▼                                                                            + order_payments + refunds
   "Refund"  ─ pick lines | full ─ restock toggles ─ refund tenders ─ reason code
            │
            ▼
   POST /api/pos/v1/sales/:orderId/refund   { kind, lines[], payments[], reasonCode,
            │                                  clientRefundId, authorizerCredentials? }
            ▼
  ┌──────────────────── issueRefund(ctx, input)  — one withTenant transaction ─────────────────────┐
  │ 1. idempotency:  (orderId, clientRefundId) already exists?  ── yes ──►  return existing refund   │
  │ 2. authorize:    ctx.user has pos:refund?  ── no ──►  resolveAuthorizer(credentials)             │
  │                       └─ resolves a manager holding pos:refund  →  authorizedByUserId            │
  │ 3. validate:     Σ payments ≤ net-paid;  per line qty ≤ ordered − already-refunded              │
  │ 4. insert:       refunds → refund_lines → refund_payments                                        │
  │ 5. restock:      for each line where restock=true:                                               │
  │                     Spec 8 present → stock_ledger row  type='refund_restock' (reverse the sale)  │
  │                     Spec 8 absent  → restockOrderItems integer add-back (fallback)               │
  │ 6. payment_status: net-paid > 0 → partially_refunded ;  net-paid == 0 → refunded                │
  │ 7. audit:        recordAuditEvent(ctx, { action:'refund.issued', entityId: refundId, … }, tx)    │
  └──────────────────────────────────────────────────────────────────────────────────────────────┘
            │  commit (all-or-nothing)
            ▼
   refund_payments = money OUT  ──►  Spec 7 reconciliation nets them against gross takings
                                     (shiftId → Spec 2 drawer;  refund.issued → Spec 4 chain)
```

## Error handling / edge cases

- **Over-refund:** `Σ this refund's payments` plus all prior refund payments cannot exceed net-paid (`Σ order_payments − change`). Exceeding it is rejected before any insert.
- **Line over-refund:** a `refund_line.quantity` above `(ordered qty − already-refunded qty)` for that `order_item` is rejected — you cannot return three of two.
- **Refunding an unpaid order:** rejected — there is nothing to return. The UI routes the user to a **void** instead (R1).
- **Duplicate submit:** the second POST with the same `(orderId, clientRefundId)` returns the first refund unchanged — same guarantee `pos_order_receipts` gives tenders.
- **Partial then full:** partial refunds accumulate; `payment_status` stays `partially_refunded` while net-paid `> 0` and becomes `refunded` when it reaches `0`.
- **Restock without Spec 8:** falls back to `restockOrderItems` integer add-back; when Spec 8 is live it writes a `refund_restock` ledger row reversing the original `sale_deduction` (per the inventory spec's restock-on-refund path).
- **`restock=false`:** money is returned, stock is not — the correct outcome for spoiled or damaged goods.
- **Card/online refund without Spec 6:** the `refund_payment` (method `card`, with `reference`) is recorded but **no gateway money moves** — record-only and flagged; once Spec 6 lands `issueRefund` calls `gateway.refund(processorTxnId, amountMinor)`.
- **No active shift:** `shiftId` is null (Spec 2 absent or refund taken off-shift); Spec 2 nets a cash refund into drawer-expected only when a shift is present.
- **Missing manager grant:** a `pos:sell` cashier without a valid `resolveAuthorizer` grant is rejected — exactly as an over-limit discount is refused without authorization.
- **Refund on a cancelled/voided order:** rejected — a voided order never finalized money; there is nothing to refund.
- **Mixed refund tenders:** a refund may split across methods (e.g. part `cash`, part `store_credit`) as long as `Σ refund_payments = totalAmount ≤ net-paid`; each tender is its own `refund_payments` row.
- **Refund amount ≠ line amounts:** for a `partial` refund `Σ refund_lines.amount` must equal `Σ refund_payments.amount` (and `totalAmount`); a goodwill amount not tied to a line is a `full`/headerless refund with no `refund_lines`, restock left off.

## Testing

- **Server (Vitest):** full refund flips `paid → refunded`; partial → `partially_refunded`; over-refund and line over-refund rejected; unpaid/voided-order refund rejected; `(orderId, clientRefundId)` idempotency returns the first refund; the `resolveAuthorizer` path — a `pos:sell` cashier **with** a manager grant succeeds and captures `authorizedByUserId`, **without** one fails; `restock=true` writes a `refund_restock` ledger row (Spec 8) or integer add-back (fallback) while `restock=false` writes neither; `recordAuditEvent('refund.issued')` is emitted **in the same transaction** and rolls back with the mutation on failure.
- **Sales history (server):** `listSales` filters by date range, cashier, order number, phone, and amount, scoped by `withTenant`; `getSale` aggregates tenders, adjustments, and refunds for one order.
- **Reconciliation contract (integration):** `refund_payments` surface as cash/card **OUT** so a Spec 7 daily close nets refunds against gross — a fixture day with one cash sale and one partial cash refund reconciles to the expected net.
- **POS route authorization:** reprint = `pos:sell` (200); refund without `pos:refund` and without a grant = 403; search/detail leak nothing across branches beyond the cashier's tenant.
- **Enum migration:** the `payment_status` extension is additive — existing `unpaid`/`partially_paid`/`paid` rows are untouched, and no order lands in `refunded`/`partially_refunded` except through `issueRefund`.
- **Reprint parity (server):** `reprintReceipt` re-renders the original sale byte-identically and, for a refunded order, appends a refund slip listing returned lines and `refund_payments`.
- **RLS:** cross-tenant refund reads and writes are blocked; FORCE RLS holds on all three tables.

## Roadmap

- **Built on — Spec 1 (Sale & Tender):** `order_payments`, `pos_adjustment_events`, `recordSale`, `resolveAuthorizer`, `REASON_CODES`, `pos_order_receipts` idempotency, and the (previously unused) `pos:refund` permission.
- **Spec 2 — Shifts & Cash Drawer:** `refunds.shiftId` lets a cash refund reduce a shift's expected drawer cash; null and inert until Spec 2 lands.
- **Spec 4 — Audit & Fingerprint Log:** registers `refund.issued` as an emission point against the existing `recordAuditEvent` helper — no chain change.
- **Spec 6 — Payments & Gateway:** `issueRefund` calls `gateway.refund()` to move card/online money; record-only until then.
- **Spec 7 — Transaction Reconciliation (this unblocks):** `refund_payments` net against gross takings in the daily close; this spec is its prerequisite.
- **Spec 8 — Inventory, Recipes & Purchasing:** the `refund_restock` `stock_ledger` movement replaces the integer add-back fallback.
- **Spec 10 — Cross-Channel Reporting (this unblocks):** the refunds-&-voids report reads `refunds` + `pos_adjustment_events`.
- **Later:** a Loyalty & Store Credit spec turns `store_credit` refunds into a redeemable balance; refund receipts and exchange (return-and-replace) flows build on these tables.
