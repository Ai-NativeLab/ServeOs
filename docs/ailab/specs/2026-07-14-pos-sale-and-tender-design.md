# ServeOS POS — Sale & Tender Design

**Date:** 2026-07-14
**Status:** Approved (design) — pending implementation plan
**Scope:** Spec 1 of 3 in the "full core POS" effort. Turns the existing order-taking app into a real cash register: staff attribution, a tender model (split/partial/change/tip), discounts, voids, held tickets, and a correct receipt.

## Context

The POS MVP (spec `2026-07-06-pos-mvp-offline-first`) shipped and is merged. It pairs a device to a branch, pulls a catalog, builds a cart, and submits a cash sale that lands in the existing orders pipeline. Two things about it are load-bearing here:

1. It shipped **online-first**, not offline-first. The SQLite store and sync engine are parked in `apps/pos/electron/_offline/`. This spec does **not** change that; the POS keeps talking directly to the cloud.
2. Payment is a single boolean-ish fact: `orders.paymentStatus` (`unpaid|paid`) plus `orders.paymentMethod` (enum with one value, `cash`). `markPaid(tenantId, orderId, _userId)` **discards** the user id. There is no payments table, no discount field, and no notion of who was standing at the counter.

## Problem

A POS that can only say "this order was paid, somehow, by nobody" is an order-taking app, not a point of sale. An owner cannot answer basic questions: who rang this sale, what discount was given and who approved it, how much came in on cash versus card, why is the till short.

## Goal

Make the money model real and correct: every sale attributed to a cashier, every payment recorded as a **tender** (with split, partial, tip, and change), and every discount or void recorded as an **authorized, reason-coded event**. Get the arithmetic right, and make the server the authority on it.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Vertical scope | **Vertical-agnostic core.** No tables/coursing/KDS, no barcode flows. |
| Payments | **Tender model, no provider integration.** Cash / card / other are *recorded* tender types; card is taken on an existing standalone terminal. |
| Staff identity | **Existing ServeOS user accounts**, email + password. Attribution by `userId`. |
| Authorization | **Existing RBAC** (`owner` / `manager` / `staff`) extended with new `pos:*` permission keys. Manager override via manager credentials, verified server-side. |
| Adjustments | **Full:** line-level and order-level discounts, line and order voids, all reason-coded and attributed. |
| Sale submission | **One atomic endpoint** creating the order and its tenders in a single transaction. |
| Totals authority | **Server recomputes and is authoritative.** Client sends `expectedTotal`; mismatch is a hard `409`. |
| Held tickets | **Server-side**, so a parked ticket is recallable from another till. |

## Non-goals (deferred by explicit decision)

- **Shifts, cash drawer, X/Z reports** → Spec 2. (`order_payments.shiftId` is added now, nullable, so Spec 2 backfills rather than migrates.)
- **Refunds, returns, sales-history lookup** → Spec 3.
- **Product variants in the POS cart.** The backend is already ready (`PlaceOrderLine.variantId` exists, `order_items.variantId` exists); the POS simply does not send it yet. Deferred on the user's call.
- **Offline-first.** The POS remains online-first; `electron/_offline/` stays parked.
- Card terminal integration, loyalty, customer accounts, per-staff PIN credentials.

## Prerequisite: one source of truth for money

This is not optional and it is not a "drift fix" — it is the foundation the rest of the spec stands on.

`apps/pos/src/order/cart.ts` computes `cartTotal` as a naive `Σ unitPrice × quantity`. It ignores VAT and the service charge. The server prices the same order through `computeOrderTotals` (`src/lib/order-totals.ts`), which is VAT-inclusive/exclusive aware and applies the service charge. **These two numbers can disagree today.** Building "amount tendered → change due" on the POS number would make the cashier hand back the wrong cash, confidently.

**Resolution:** `src/lib/order-totals.ts` is pure TypeScript with no Next.js dependencies. The POS renderer imports **that exact module** through a Vite path alias. There is one implementation of the arithmetic, not two. `cartTotal` is deleted.

To use it, the catalog payload (`GET /api/pos/v1/catalog`) must also carry the tenant's `CheckoutPricing` (`vatRate`, `vatInclusive`, `serviceChargeRate`), which it does not today.

## Money math (normative)

Order of operations, applied identically on both sides:

1. `lineTotal = (unitBasePrice × quantity) − lineDiscount`
2. `subtotal = Σ lineTotal`
3. `discountedSubtotal = subtotal − orderDiscount`
4. `computeOrderTotals(pricing, discountedSubtotal, deliveryFee = 0)` → `{ serviceChargeAmount, vatAmount, total }`
5. `amountDue = total`; `paidSoFar = Σ tender.amount`; `remaining = amountDue − paidSoFar`
6. Cash only: `changeAmount = tenderedAmount − amountApplied`

The **only** novel arithmetic in this spec is steps 1–3 (discounts) and 5–6 (tendering). The service charge and VAT are **not** recomputed here — `computeOrderTotals` owns them, and it is called exactly once, with the *discounted* subtotal. Discounts therefore reduce the taxable base, which is the correct behaviour and the reason the discount must be applied before the call rather than after.

Rules:
- **Tips are additive and never taxed.** A tip increases what the customer hands over; it does not enter `subtotal`, VAT, or the service charge. It is recorded on the tender, not on the order total.
- **Only cash produces change.** A card/other tender whose amount exceeds `remaining` is rejected.
- Rounding uses `computeOrderTotals`'s existing `round2`. No second rounding scheme is introduced.
- A line discount may not exceed its line total; an order discount may not exceed the subtotal.

## Data model

### New: `order_payments` (tenders)

The money source of truth. One row per tender, so a split payment is simply two rows.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `orderId` | |
| `method` | new enum `pos_tender_method`: `cash \| card \| other` |
| `amount` | numeric — the amount applied to the order |
| `tipAmount` | numeric, default `0` |
| `tenderedAmount` | numeric, nullable — cash handed over |
| `changeAmount` | numeric, nullable — cash given back |
| `reference` | text, nullable — card last-4 / txn ref, free text |
| `takenByUserId` | uuid → `users.id` |
| `shiftId` | uuid, **nullable** — unused here; Spec 2 populates it |
| `clientPaymentId` | text — idempotency for retried tender submissions |
| `createdAt` | |

Unique index on `(orderId, clientPaymentId)`.

### New: `pos_adjustment_events` (audit trail)

Every discount and void, with who did it and who authorized it. Append-only.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `orderId` | |
| `orderItemId` | uuid, nullable — null for order-level adjustments |
| `type` | enum: `line_discount \| order_discount \| line_void \| order_void` |
| `amount` | numeric |
| `reasonCode` | text — fixed set (below) |
| `reasonText` | text, nullable — required when `reasonCode = other` |
| `byUserId` | the cashier who performed it |
| `authorizedByUserId` | the manager who approved it (equal to `byUserId` when the cashier holds the permission themselves) |
| `createdAt` | |

**Reason codes** are a constant in code, not a table: `staff_meal`, `comp_service`, `promo`, `manager_discretion`, `wrong_item`, `customer_changed_mind`, `other`.

### New: `pos_held_tickets`

Server-side so a ticket parked at till 1 can be recalled at till 2.

`id`, `tenantId`, `branchId`, `deviceId`, `cashierUserId`, `label` (free text — "Table 4", a customer name), `draftJson` (lines + discounts), `createdAt`, `updatedAt`. Deleted on recall-and-complete.

### Extended tables

- **`orders`**: add `cashierUserId` (uuid, nullable — null for web orders), `discountAmount` (numeric, default `0`), `discountReason` (text, nullable).
- **`order_items`**: add `discountAmount` (numeric, default `0`).
- **`order_channel`** enum: add `pos`. POS sales are no longer mislabelled `web`.
- **`payment_status`** enum: add `partially_paid`.
- **`orders.paymentMethod`**: retained for existing web orders only. For POS sales, `order_payments` is authoritative and this column is not read.

## Authorization

Extend `src/server/rbac/permissions.ts`:

- New permissions: `pos:sell`, `pos:discount`, `pos:void`, `pos:refund` (the last is defined now but unused until Spec 3).
- `owner`: all four. `manager`: all four. `staff`: `pos:sell` only.

**Manager override flow.** A `staff` cashier taps "Discount" → the POS presents a manager-auth modal → the cashier hands the terminal to a manager, who enters their own email + password → `POST /api/pos/v1/authorize` validates the credentials *and* checks the permission → returns a short-lived, single-use **authorization grant** (opaque token, ~2 min TTL, scoped to one permission) → the POS attaches it to the sale request → the server consumes it and records `authorizedByUserId`.

The client never asserts its own authority. Hiding the button is a UX affordance; the server enforces regardless. A request carrying a discount without either the cashier holding `pos:discount` or a valid grant is a `403`.

Manager-auth attempts are rate-limited per device.

## API

All under the existing `/api/pos/v1/`, device-authenticated as today, with the cashier's session layered on top.

- `POST /api/pos/v1/cashier/login` — email + password → a **cashier token** plus that user's `pos:*` permissions. The device token identifies the *terminal*; the cashier token identifies the *human*. Both are sent on every subsequent request: the device token stays in `Authorization: Bearer`, and the cashier token rides in an `X-POS-Cashier` header. The Electron main process holds both (the cashier token in memory only, so closing the app signs the cashier out but leaves the device paired). A `requirePosCashier()` helper resolves `{ device, cashierUserId, permissions }` and is the analog of the existing `requirePosDevice()`.
- `POST /api/pos/v1/authorize` — manager credentials + requested permission → single-use grant.
- `GET /api/pos/v1/catalog` — **extended** to include `CheckoutPricing`.
- `POST /api/pos/v1/sales` — the sale. Body:
  ```
  { clientOrderId, lines[], orderDiscount?, expectedTotal, payments[], grants[]? }
  ```
  Creates the order (`channel: "pos"`, `cashierUserId`, discounts) **and** its `order_payments` rows **and** its `pos_adjustment_events` rows in one transaction. Sets `paymentStatus` to `paid` when `Σ payments ≥ total`, else `partially_paid`. Returns the full receipt payload.
  Idempotent on `clientOrderId`, exactly as the existing endpoint is.
- `POST /api/pos/v1/sales/:id/payments` — add a tender to a `partially_paid` sale. Idempotent on `clientPaymentId`.
- `POST /api/pos/v1/held-tickets`, `GET /api/pos/v1/held-tickets`, `DELETE /api/pos/v1/held-tickets/:id`.

`submitPosOrder` (`src/server/pos/submit-order.ts`) is superseded by a `recordSale` service that does the same idempotency dance but writes tenders and adjustments too. `markPaid`'s discarded-`userId` problem simply goes away: the POS no longer calls it.

## Server-authoritative totals

The POS sends the `expectedTotal` it displayed to the customer. The server recomputes the total from live catalog prices and current pricing config. **On any mismatch it returns `409` with both figures and does not create the order.**

This is the stale-catalog guard. A POS holding a cached menu whose prices changed would otherwise quietly take the wrong amount of money. Instead the cashier sees "prices have changed — review the cart", the POS re-pulls the catalog, and the sale is re-rung. Failing loudly on a price mismatch is the only acceptable behaviour for a cash register.

## Screens

| Screen | State |
|---|---|
| Device pairing | exists, unchanged |
| **Cashier sign-in** | new — email/password, layered over the paired device |
| **Sale entry** | upgraded — quantity stepper, line note, line discount, void line, order discount, park ticket, recall held ticket |
| **Payment** | new — amount due, tender buttons (Cash / Card / Other), quick-cash chips (exact / next note up), numeric keypad, live "paid so far / remaining", tip entry, change due on completion |
| **Manager authorization** | new — modal, manager email + password, states the action being authorized |
| **Held tickets** | new — list, recall, discard |
| **Receipt** | upgraded — line discounts, order discount, service charge, VAT, one line per tender, change given, cashier name, reprint |
| Live orders queue | exists, unchanged |

The payment screen is the highest-risk UI in the spec: it is where a mistake becomes wrong money in a customer's hand. `remaining` must be visible at all times, and the "complete sale" action must be disabled while `remaining > 0`.

## Error handling / edge cases

- **Price drift:** `409` total mismatch → POS refreshes catalog, flags the cart. No order created.
- **Duplicate submit / retry:** idempotent on `clientOrderId`; the original receipt is returned.
- **Overpayment on card/other:** rejected — only cash yields change.
- **Discount exceeds line or subtotal:** rejected server-side.
- **Staff bypasses the UI:** `403` — the server checks the permission or the grant, always.
- **Expired/reused manager grant:** `403`, cashier re-authorizes.
- **Failed tender mid-sale:** impossible to half-apply — the sale is one transaction. Nothing is written, and the cashier retries.
- **Partial payment abandoned:** the order remains `partially_paid` and is visible for top-up. (Voiding a `partially_paid` order requires a refund, which is Spec 3 — until then it stays open.)
- **Cashier session expires mid-cart:** the cart is preserved in the renderer; sign-in is re-prompted at charge time.

## Testing

- **Money math (unit, pure):** discounts (line + order), the operation order above, split tenders, partial payment, change, tips excluded from tax. Extends the existing `src/lib/order-totals.test.ts`.
- **Parity test:** the POS-displayed total equals the server-computed total for a fixture cart. This is the test that would have caught the bug this spec exists to fix.
- **Server (Vitest):** `POST /sales` creates a `pos`-channel order, attributes the cashier, applies discounts, writes tenders, sets `paid` vs `partially_paid` correctly, is idempotent on `clientOrderId`, returns `409` on total mismatch, returns `403` for a `staff` discount without a grant, records `authorizedByUserId` when a grant is used, and rejects an expired/reused grant.
- **Renderer:** cart with discounts, payment keypad arithmetic, "complete" disabled while `remaining > 0`, receipt contents.
- **Manual acceptance:** sign in as staff → build cart → discount is blocked → manager authorizes → discount applies → pay half cash, half card → receipt shows both tenders, the discount, VAT, and change → order appears in the dashboard as a POS-channel sale attributed to the cashier.

## Roadmap

- **Spec 2 — Shifts & Cash Drawer:** open with float, pay-in/pay-out, X-report, blind close, over/short, Z-report. Populates `order_payments.shiftId`.
- **Spec 3 — Refunds & Sales History:** ticket lookup, partial refund by line, refund tender, restock, refund receipt.
- **Later:** variants in the POS cart, offline-first (un-park `electron/_offline/`), per-staff PIN credentials, hardware (ESC/POS, drawer kick, scanner), card terminal integration.
