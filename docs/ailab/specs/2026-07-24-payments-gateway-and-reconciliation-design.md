# ServeOS — Payments, Gateway & Transaction Reconciliation Design

**Date:** 2026-07-24
**Status:** Draft — pending review
**Scope:** Specs **6 (Payments & Gateway)** and **7 (Transaction Reconciliation)** of the core-POS roadmap, combined here because 7 cannot be tested without 6 producing something to reconcile against. Part A introduces the first real payment gateway; Part B ties every peso of every order — cash, card, online, refund — back to what actually landed. This spec **depends on two prerequisites that are not yet written**: **Spec 2 — Shifts & Cash Drawer** (the `cash_counts` / drawer-per-shift model the cash-reconciliation layer reads) and **Spec 3 — Refunds & Sales History** (refund tenders and restock, which the settlement and daily-close math must net out). Where this spec needs a table from 2 or 3, it names it and treats it as an input, not something it defines.

## Context

Payment in ServeOS today is a single boolean-ish fact. `orders.paymentStatus` is `unpaid | partially_paid | paid`; `orders.paymentMethod` is an enum with exactly **one** value, `cash` (`src/server/ordering/schema.ts:11`). The web storefront's checkout button literally says **"Place order (Cash)"** (`src/app/checkout/CheckoutForm.tsx:306`) and the order is settled later by a manual `markPaid` (`src/server/ordering/service.ts:400`). The POS records tenders in `order_payments` with a `method` of `cash | card | other` (`src/server/pos/tender-schema.ts:8`), but **nothing is processed**: a `card` tender is a note that a card was swiped on some standalone terminal, with an optional free-text `reference`. There is no gateway, no capture, no webhook, no settlement file — and therefore nothing to reconcile a day's takings against beyond the honesty of the person at the till.

The one piece of prior art worth mirroring is `BillingProvider` (`src/server/billing/provider.ts`): a tiny `interface` (`createInvoice`, `settleInvoice`) with one concrete `ManualBillingProvider` behind it and a clean `index.ts` re-export. That is exactly the shape the gateway layer should take.

## Problem

Two gaps, one causal chain. First, ServeOS cannot take money online — a customer who wants to pay by card on the storefront can't; cash-on-collection is the only path, which is a non-starter for delivery and for any tenant whose customers expect to prepay. Second, and downstream of the first, an owner has **no way to prove the day balanced**. Cash in the drawer is unverified against sales; card takings live only as free-text references; and there is no external truth — no gateway payout — to check any of it against. "Did we actually receive the money the system says we sold?" is unanswerable.

## Goal

Make money **received**, not just recorded. Introduce a `PaymentGateway` abstraction and a first real integration so the storefront can take card/wallet payments online, confirmed by a verified webhook, written as a first-class tender. Then close the loop: reconcile every order's tenders to its total, every shift's counted cash to its expected cash, and every gateway payout to the tenders it claims to settle — and roll all three into a single daily-close report that can be anchored into the tamper-evident audit chain.

## Decisions (locked)

Inherited from the roadmap (`docs/ROADMAP.md`, decisions D2 and D3) and binding on this spec.

| Decision | Choice |
|---|---|
| Payment gateway (D3) | **Paymob first**, behind a `PaymentGateway` provider interface that mirrors `BillingProvider`. EG/EGP-native. Tap, Checkout.com, Fawry, Stripe are future providers on the same interface. *Recommended — pending owner sign-off.* |
| Reconciliation scope (D2) | **Daily close + cash drawer + external settlement.** Three layers: order↔tender integrity, counted-cash-per-shift, and gateway-payout-vs-recorded-tender matching. |
| Online payment model | **Prepayment via gateway, webhook-confirmed.** The webhook — never the browser redirect — is the source of truth that flips `paymentStatus`. |
| Tender authority | **`order_payments` stays the single money source of truth.** Online payments become rows in it, alongside POS tenders; `orders.paymentMethod` remains legacy-web-only. |
| POS card tenders | **Record-only by default.** No integrated terminal in v1; a card tender carries a `reference`. An integrated-terminal path is designed for but not built. |
| Money convention | **Unchanged.** All monetary values remain `numeric` strings via `money(n)` (`src/server/ordering/service.ts:55`). Gateways deal in **minor units** (piastres); conversion happens only at the provider boundary. |
| Reconciliation authority | **Server-computed, immutable runs.** A `reconciliation_run` is a snapshot; re-running produces a new row rather than mutating an old one. Exceptions are the actionable output. |

## Non-goals (deferred by explicit decision)

- **Shifts, cash drawer, `cash_counts`** → **Spec 2** (prerequisite). Part B's cash layer *reads* that model; it does not define it. Until Spec 2 lands, the cash layer degrades to "unavailable", not "wrong".
- **Refund mechanics, restock, refund receipts** → **Spec 3** (prerequisite). This spec consumes refund tenders as negative/refund-typed rows; it does not build the refund UI or `gateway.refund()` call sites beyond the interface method.
- **Integrated POS card terminals** (physical PIN pads) → later. The `PaymentGateway` interface leaves room; v1 POS card is record-only.
- **Payouts/settlement reconciliation for cash-on-collection delivery couriers** → out of scope; that's an operations concern, not a gateway one.
- **Multi-currency per tenant, FX, split settlement across providers** → out of scope. One gateway, one currency (the tenant's) per tenant in v1.
- **Subscription/plan billing** — that is `BillingProvider`'s job and stays separate; this spec is customer-order payments only.

---

## Part A — Payments & Gateway

### The provider interface

A new `PaymentGateway` interface (`src/server/payments/provider.ts`), shaped exactly like `BillingProvider`: a `readonly name`, and a small set of async methods. One concrete implementation ships in v1 — `PaymobGateway` — with the others named as future work on the same contract.

```
export interface PaymentGateway {
  readonly name: string;                                    // "paymob"
  createPayment(input: CreatePaymentInput): Promise<PaymentIntent>;   // → hosted/embedded checkout
  capture(processorTxnId: string): Promise<PaymentResult>;            // for auth/capture flows
  refund(processorTxnId: string, amountMinor: number): Promise<RefundResult>; // used by Spec 3
  parseWebhook(raw: RawWebhook): ParsedWebhook;             // verify signature + normalize
  fetchSettlement(dateRange: DateRange): Promise<SettlementBatch>;    // pull payout/settlement lines
}
```

`createPayment` takes `{ tenantId, orderId, amountMinor, currency, customer, returnUrl }` and returns a `PaymentIntent` carrying the `processorTxnId` and a `checkoutUrl` (redirect) or `iframeToken` (embedded). `parseWebhook` is pure — it takes the raw body + headers, **verifies the HMAC signature**, and returns a normalized `{ processorTxnId, status, amountMinor, paidAt }` or throws `WebhookSignatureError`. `fetchSettlement` is what Part B's external-settlement layer calls.

**Why Paymob first (recommended, pending owner sign-off).** Every tenant today defaults to `country = "EG"`, `currency = "EGP"`, `timezone = "Africa/Cairo"` (`src/server/tenancy/schema.ts:18-21`); the only other supported country is `SA`. Paymob is the dominant Egyptian PSP: it settles in EGP, supports local cards (Meeza), mobile wallets, and installment rails that an EG/EGP-native customer base expects, and it exposes exactly the create-intent → hosted-iframe → webhook → settlement-report flow this design is built around. Choosing it first means the first integration exercises the interface against the market ServeOS actually serves. `TapGateway`, `CheckoutComGateway`, `FawryGateway` (EG cash-voucher / reference-pay), and `StripeGateway` are all expressible on the identical interface and are deferred until a tenant needs them — a `SA`-country tenant, for instance, would want Tap or Checkout.com. **This choice needs the owner's sign-off (roadmap open question #1) before implementation starts.**

### Data model

Per the roadmap's canonical names, Part A **extends `order_payments`** and adds **one** new table. Settlement tables live in Part B where they are consumed.

#### Extended: `order_payments`

The tender table gains gateway provenance. All new columns are nullable so existing cash/POS rows are untouched.

| Column | Notes |
|---|---|
| `method` | enum `pos_tender_method` — **extended** from `cash \| card \| other` to add `wallet` and `online`. `online` marks a web-storefront gateway payment; `card` stays for POS card tenders (record-only or, later, integrated-terminal). |
| `gatewayProvider` | text, nullable — the `PaymentGateway.name` (`"paymob"`). Null for cash/manual tenders. |
| `processorTxnId` | text, nullable — the gateway's transaction id. **The join key** the settlement layer (Part B) matches payouts on. Indexed. |
| `status` | text, nullable — tender lifecycle for gateway rows: `pending \| authorized \| captured \| failed \| refunded`. Null (implicitly captured) for cash. |
| *existing* | `amount`, `tipAmount`, `tenderedAmount`, `changeAmount`, `reference`, `takenByUserId`, `shiftId`, `clientPaymentId`, `createdAt` — unchanged. `takenByUserId` becomes **nullable** because an online payment has no cashier; a system-actor sentinel or null is used. |

The `(orderId, clientPaymentId)` unique index already present is reused for online idempotency: the checkout session's id is the `clientPaymentId`.

#### New: `payment_gateway_events`

Every inbound webhook, stored raw, deduped, and verified — the audit trail for anything the gateway ever told us. Append-only.

| Column | Notes |
|---|---|
| `id`, `tenantId` | tenant-scoped, FORCE RLS. |
| `provider` | text — `"paymob"`. |
| `eventId` | text — the provider's own event/delivery id. **Unique with `provider`** — the idempotency key. |
| `processorTxnId` | text, nullable — links the event to an `order_payments` row once matched. |
| `orderId` | uuid, nullable — resolved from `processorTxnId` at handling time. |
| `type` | text — normalized: `payment.succeeded \| payment.failed \| payment.refunded`. |
| `signatureValid` | boolean — result of HMAC verification. A `false` row is stored (for forensics) but **never** acted on. |
| `rawPayload` | jsonb — the verbatim body, for replay and dispute evidence. |
| `processedAt` | timestamp, nullable — set when the handler finished; null = received-not-yet-applied. |
| `createdAt` | |

Unique index on `(provider, eventId)`. This is the webhook dedupe: a provider that retries a delivery hits the unique constraint, the second insert is a no-op, and no second tender is written.

### Authorization

New permission `payments:manage` (owner + manager), added to `src/server/rbac/permissions.ts` alongside the existing `pos:*` keys. It gates provider configuration (API keys, webhook secrets), manual capture/void from the dashboard, and viewing raw gateway events. **The customer-facing create-payment call needs no permission** — it is initiated by the storefront on the customer's own order, exactly as `placeOrder` is today. **The webhook endpoint is unauthenticated by RBAC and authenticated by signature**: it carries no user session, so `parseWebhook`'s HMAC check *is* its authorization. Refunds route through Spec 3's `pos:refund`; this spec only exposes the `gateway.refund()` primitive.

### API

Online payment lives on the public storefront surface (`/api/`), not the device-authenticated POS surface (`/api/pos/v1/`).

- `POST /api/orders` — **unchanged as the order-creating call**, but the response is extended: when the tenant has a gateway configured and the customer chose to prepay, the server calls `gateway.createPayment` and returns `{ ...order, payment: { checkoutUrl | iframeToken, processorTxnId } }`. The order is created `paymentStatus: "unpaid"`; **no tender is written yet.** Cash-on-collection omits the payment block and behaves exactly as today ("Place order (Cash)" stays a valid path).
- `POST /api/payments/webhook/:provider` — the gateway callback. Reads the raw body, `parseWebhook` verifies the signature, dedupes on `(provider, eventId)`, and on a `payment.succeeded` writes the `order_payments` row (`method: "online"`, `gatewayProvider`, `processorTxnId`, `status: "captured"`) **and** flips `orders.paymentStatus` to `paid` — in one transaction. Always returns `200` once persisted (even for a duplicate) so the provider stops retrying; returns `400` only on a signature failure.
- `GET /api/orders/[token]/status` — **extended** to surface `paymentStatus` so the storefront's post-redirect "thank you" page can poll for confirmation rather than trusting the redirect.
- `POST /api/payments/:orderId/capture` and `POST /api/payments/:orderId/refund` — dashboard, `payments:manage` (refund also needs Spec 3). Thin wrappers over `gateway.capture` / `gateway.refund`.

The web checkout gains a payment-method choice (**Card / Wallet / Cash on collection**) ahead of the current single button; the redirect/iframe replaces the immediate order confirmation for prepaid orders, and the confirmation page becomes webhook-driven.

### Architecture — online payment (webhook-confirmed)

The redirect tells the *browser* the payment probably worked; the webhook tells the *server* it definitely did. Only the second writes money.

```
  Storefront            ServeOS API              PaymentGateway            Paymob
  (browser)             (/api/…)                 (PaymobGateway)           (PSP)
     │                     │                          │                     │
     │  POST /api/orders   │                          │                     │
     │────────────────────►│  placeOrder() → order    │                     │
     │                     │  (paymentStatus=unpaid)  │                     │
     │                     │  createPayment() ───────►│  create intent ────►│
     │                     │                          │◄─── processorTxnId ─│
     │◄── checkoutUrl / ───│                          │                     │
     │    iframeToken      │                          │                     │
     │                                                                      │
     │  redirect / iframe: customer enters card ───────────────────────────►│
     │◄─────────────── 3DS / OTP challenge, then return to returnUrl ───────│
     │                     │                          │                     │
     │                     │   POST /api/payments/webhook/paymob  ◄──────────│  (server→server)
     │                     │   parseWebhook(): verify HMAC                   │
     │                     │   dedupe (provider,eventId) in                  │
     │                     │     payment_gateway_events                      │
     │                     │   ┌──────────── one tx ─────────────┐           │
     │                     │   │ insert order_payments           │           │
     │                     │   │   (method=online, captured)     │           │
     │                     │   │ update orders.paymentStatus=paid│           │
     │                     │   └─────────────────────────────────┘           │
     │  GET status (poll) ►│   paymentStatus: paid                           │
     │◄── "Payment confirmed"                                                │
```

Cash-on-collection skips the entire right half: `POST /api/orders` returns the order with no payment block, and it settles later exactly as it does today.

### Error handling / edge cases

- **Duplicate webhook delivery:** the `(provider, eventId)` unique constraint absorbs it — second insert is a no-op, no double tender. Return `200`.
- **Invalid signature:** stored with `signatureValid = false`, **never acted on**, return `400`. Alerts on a threshold (possible spoofing).
- **Webhook arrives before the browser returns** (common): the order is already `paid` by the time the confirmation page polls — the redirect landing simply reflects it. No ordering assumption is made.
- **Webhook never arrives:** a reconciliation-time sweep (Part B) and `fetchSettlement` catch the orphaned intent; the order stays `unpaid` and is visible as such. A scheduled poll of pending intents older than N minutes can also self-heal.
- **Customer abandons at the gateway:** order remains `unpaid`; no tender; eligible for cleanup. Never silently "paid".
- **Amount mismatch** (webhook amount ≠ order total): tender written but flagged; `paymentStatus` **not** flipped to `paid`; raised as a reconciliation exception. Loud, not silent.
- **Partial capture / auth-then-capture:** `status` tracks `authorized` vs `captured`; `paymentStatus` flips only on capture.
- **Refund after settlement:** handled as a negative movement in Part B's settlement math; the tender `status` becomes `refunded` (Spec 3 owns the trigger).
- **Provider not configured:** `createPayment` is skipped; storefront offers only cash-on-collection. No hard failure.

### Testing

- **`parseWebhook` (unit, pure):** valid signature parses; tampered body throws `WebhookSignatureError`; each event type normalizes correctly; minor-unit → `money()` conversion is exact.
- **Idempotency:** the same `(provider, eventId)` delivered twice writes one tender and one event row; concurrent deliveries serialize on the unique index.
- **Flow (Vitest):** `POST /api/orders` with prepay returns a `checkoutUrl` and an `unpaid` order; the webhook then writes an `online` tender and flips to `paid` in one transaction; cash-on-collection still returns an order with no payment block.
- **Amount-mismatch webhook** does not flip `paymentStatus` and raises an exception.
- **Provider abstraction:** a fake `PaymentGateway` (mirroring `manual-provider.test.ts`) drives the flow with no network, proving the interface — not Paymob — is what the app depends on.

---

## Part B — Transaction Reconciliation

Reconciliation answers one question in three layers of increasing scope: **does what we recorded match what we received?** Layer (a) is internal arithmetic (do the tenders add up?), (b) is physical (is the cash actually in the drawer?), and (c) is external (did the bank actually pay us?). The daily close runs all three and produces one report.

### The three layers

- **(a) Order ↔ tender integrity** — pure DB integrity, needs nothing external. For every order in the window: `Σ tender.amount − Σ tender.changeAmount` must equal `orders.total` for a `paid` order (or be `< total` for `partially_paid`); **no orphan tenders** (an `order_payments` row whose order is missing or voided); and `clientPaymentId` unique per order (already enforced by the existing index — the run *verifies* it rather than assuming it). Tips are excluded from the order-total tie, consistent with the Sale & Tender rule that tips never enter the order total.
- **(b) Cash drawer per shift** — **depends on Spec 2.** Expected cash = `opening float + Σ cash tenders − Σ cash refunds/payouts` for the shift; counted cash comes from Spec 2's `cash_counts` (the blind close). `variance = counted − expected`; any non-zero variance is flagged as an exception with its magnitude. Until Spec 2 lands this layer reports "cash reconciliation unavailable (Spec 2 pending)" rather than producing a false zero.
- **(c) External settlement** — match the gateway's payout to what we think it owes us. `fetchSettlement` pulls the provider's settlement/payout lines into `settlement_batches` / `settlement_lines`; each line is matched to an `order_payments` row **by `processorTxnId`**. Every line resolves to one of: **matched** (line ↔ tender, amounts agree net of fee), **unmatched** (a payout line with no tender, or a captured tender with no payout — money moved that the system can't explain), or **fee** (the processor's cut — modeled explicitly, see below). Fees mean the payout is *smaller* than gross tenders; that gap must equal the sum of fee lines or it becomes an exception.

**Modeling processor fees.** A settlement line carries `grossMinor`, `feeMinor`, and `netMinor` (`gross − fee`). Reconciliation ties `order_payments.amount` to `grossMinor` (what the customer paid), records `feeMinor` as an expense the reporting layer (Spec 10) can sum, and checks that `Σ netMinor` equals the actual bank payout for the batch. A tender is only "settled" once its line is matched and the batch's net ties out.

### Data model

Four new tables (canonical roadmap names). All tenant-scoped, FORCE RLS. Settlement tables belong to the Payments namespace but are consumed here.

#### New: `settlement_batches`

One row per payout the gateway makes — the header for a group of lines.

| Column | Notes |
|---|---|
| `id`, `tenantId` | |
| `provider` | text — `"paymob"`. |
| `externalBatchId` | text — the provider's payout/batch id. Unique with `provider`. |
| `payoutDate` | date — when the bank credit landed. |
| `grossMinor` | bigint — sum of gross across lines, minor units. |
| `feeMinor` | bigint — total processor fees for the batch. |
| `netMinor` | bigint — actual expected bank credit (`gross − fee`). |
| `currency` | text. |
| `status` | text — `imported \| reconciled \| exceptions`. |
| `fetchedAt`, `createdAt` | |

#### New: `settlement_lines`

One row per transaction the payout claims to settle.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `batchId` | → `settlement_batches`. |
| `processorTxnId` | text — **the match key** against `order_payments.processorTxnId`. Indexed. |
| `orderPaymentId` | uuid, nullable — set when matched. |
| `type` | text — `payment \| refund \| fee \| adjustment`. |
| `grossMinor`, `feeMinor`, `netMinor` | bigint — per-line money. |
| `matchStatus` | text — `matched \| unmatched \| fee_only`. |
| `createdAt` | |

#### New: `reconciliation_runs`

An immutable snapshot of one reconciliation. Re-running writes a **new** row.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `branchId` | `branchId` nullable — a run may be tenant-wide or per-branch. |
| `businessDate` | date — the close day, computed in the **tenant timezone** (`tenants.timezone`, e.g. `Africa/Cairo`). |
| `kind` | text — `order_tender \| cash_drawer \| settlement \| daily_close`. A `daily_close` composes the other three. |
| `shiftId` | uuid, nullable — set for `cash_drawer` runs (Spec 2). |
| `expectedMinor`, `countedMinor`, `varianceMinor` | bigint — the headline numbers for the layer. |
| `channelBreakdown` | jsonb — per-channel (`web`/`pos`) and per-method (`cash`/`card`/`wallet`/`online`/`refund`) totals. |
| `status` | text — `balanced \| exceptions`. |
| `auditEventId` | uuid, nullable — the Spec 4 `audit_events` row this close was anchored into (see below). |
| `runByUserId` | uuid — who ran it. |
| `createdAt` | |

#### New: `reconciliation_exceptions`

The actionable output — everything that didn't tie out. This is what a manager works through.

| Column | Notes |
|---|---|
| `id`, `tenantId`, `runId` | → `reconciliation_runs`. |
| `layer` | text — `order_tender \| cash_drawer \| settlement`. |
| `code` | text — `orphan_tender \| tender_total_mismatch \| cash_variance \| unmatched_payout \| unsettled_tender \| amount_mismatch \| fee_gap`. |
| `orderId`, `orderPaymentId`, `settlementLineId` | uuid, nullable — whichever entities the exception points at. |
| `expectedMinor`, `actualMinor`, `deltaMinor` | bigint — the discrepancy. |
| `detail` | jsonb — human-readable context. |
| `resolvedByUserId`, `resolvedAt`, `resolutionNote` | nullable — an exception can be acknowledged/annotated, never deleted. |
| `createdAt` | |

### Daily close ("End of Day")

The capstone. For a given `businessDate` (bucketed in the **tenant timezone**, so a Cairo tenant's day runs midnight-to-midnight Africa/Cairo regardless of server UTC), the close:

1. Aggregates **all channels** — `web` and `pos` orders alike — for that business day.
2. Runs layer (a) over every order, layer (b) over each shift's drawer (Spec 2), and layer (c) over the day's settlement batches.
3. Reconciles **cash + card + online + refunds** into the `channelBreakdown`, netting refunds against gross.
4. Writes one `reconciliation_run` (`kind: daily_close`) plus any `reconciliation_exceptions`.
5. **Emits an audit event** (Spec 4's `recordAuditEvent`) capturing the run's totals and status; because that chain is hash-anchored, the daily close becomes **tamper-evident** — the `auditEventId` is stored back on the run. A later attempt to quietly alter a closed day breaks the chain the Spec 4 verifier walks.

### Authorization

- `reconciliation:manage` (owner + manager) — run a reconciliation, view runs, resolve/annotate exceptions.
- `reports:financial` (owner + manager) — view the money-bearing daily-close report (variance, fees, settlement). Per the roadmap this is deliberately **owner + manager**, not owner-only, so a branch manager can close their own day.
- `payments:manage` (from Part A) additionally gates re-triggering a `fetchSettlement` import.

All three are added to `src/server/rbac/permissions.ts`; the daily close reads across channels within the tenant's RLS scope via `withTenant`.

### API

Dashboard surface, all behind the permissions above.

- `POST /api/reconciliation/runs` — body `{ kind, businessDate, branchId?, shiftId? }`. Runs the layer(s) and returns the run + its exceptions. `reconciliation:manage`.
- `GET /api/reconciliation/runs?businessDate=…` — list runs for a day; `GET /api/reconciliation/runs/:id` — one run with exceptions and breakdown. `reports:financial`.
- `POST /api/reconciliation/exceptions/:id/resolve` — annotate/acknowledge. `reconciliation:manage`.
- `POST /api/settlement/import?provider=…` — trigger `fetchSettlement` for a date range → `settlement_batches` / `settlement_lines`. `payments:manage`. Also runnable on a schedule.
- `POST /api/reconciliation/daily-close` — the End-of-Day: runs all three layers, writes the `daily_close` run, and anchors it into the audit chain. `reports:financial`.

### Architecture — the three reconciliation layers

```
                         DAILY CLOSE  (businessDate, tenant tz: Africa/Cairo)
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                 ▼
 (a) ORDER ↔ TENDER            (b) CASH DRAWER / SHIFT           (c) EXTERNAL SETTLEMENT
     integrity                     ── depends on Spec 2 ──            ── gateway payout ──
        │                                 │                                 │
  orders ──┐                    opening float                       fetchSettlement()
  order_payments               + Σ cash tenders                            │
        │  Σ amount − change    − Σ cash refunds/payouts           settlement_batches
        │  == order.total       = expected                          settlement_lines
        │  no orphan tenders          │                                    │
        │  unique clientPaymentId  counted (cash_counts, Spec 2)    match by processorTxnId
        ▼                             ▼   variance = counted−exp    ── matched / unmatched / fee
   pass / mismatch              pass / variance flagged             net = gross − fee ties to payout
        │                             │                                    │
        └──────────────► reconciliation_exceptions ◄──────────────────────┘
                                      │
                          reconciliation_runs  (immutable snapshot)
                                      │
                          recordAuditEvent()  →  audit_events  (Spec 4, hash-anchored)
```

### Error handling / edge cases

- **Missing prerequisite (Spec 2):** the cash layer reports "unavailable", the run still completes with layers (a) and (c); the daily close is marked partial, never falsely "balanced".
- **Settlement arrives days later** (payouts lag sales): a tender is `captured` but `unsettled` for a window; that is normal, not an exception, until an aging threshold is crossed — then `unsettled_tender`.
- **Refund crossing a close boundary:** netted into whichever business day it settled in; the original day's close is not retroactively mutated (runs are immutable — a correcting run is issued instead).
- **Re-running a day:** always a new `reconciliation_run` row; the previous run and its audit anchor stand. History is append-only.
- **Rounding:** all internal math is in integer minor units (piastres) to avoid float drift; only display converts via `money()`. A ±1 minor-unit tie is not an exception; anything larger is.
- **Orphan tender** (tender with no live order): surfaced as `orphan_tender`, never silently dropped.
- **DST / timezone edges:** business-day bucketing uses the tenant timezone consistently on both write and read, so a day is never double-counted or split by a server-UTC boundary.

### Testing

- **Layer (a) (unit):** balanced order passes; a tender-total mismatch, an orphan tender, and a duplicate `clientPaymentId` each raise the right exception code; tips excluded from the tie.
- **Layer (b):** expected-cash formula against a fixture shift; a planted over/short produces a `cash_variance` of the right sign and magnitude; absent Spec 2 the layer degrades cleanly.
- **Layer (c):** a settlement batch matches by `processorTxnId`; an unmatched payout line and an unsettled tender each surface; fee lines reconcile so that `Σ net == payout`; a fee gap is caught.
- **Daily close (Vitest):** a fixture business day of mixed `web` + `pos`, cash + online + one refund reconciles to `balanced`; timezone bucketing places a 23:30 Cairo order in the right day; the close writes exactly one `daily_close` run and anchors an `audit_events` row whose hash chains onto the previous head.
- **Immutability:** re-running a day appends a new run and never mutates the prior one or its `auditEventId`.

---

## Roadmap

- **Prerequisite — Spec 2 (Shifts & Cash Drawer):** must land for Part B layer (b). Provides `cash_counts`, opening float, blind close, and populates `order_payments.shiftId` — which Part B's cash layer and per-shift `reconciliation_runs` read directly.
- **Prerequisite — Spec 3 (Refunds & Sales History):** must land for refund tenders to net correctly in the daily close and settlement math; also the caller of `gateway.refund()`.
- **Depends on — Spec 4 (Audit & Fingerprint Log):** the daily close anchors into `audit_events`; without Spec 4 the close still runs but is not hash-anchored (the `auditEventId` stays null).
- **Enables — Spec 10 (Cross-Channel Reporting):** the daily reconciliation summary, tenders/tips by method, and processor-fee totals modeled here feed the manager reports; `reports:financial` is shared between the two specs.
- **Later — additional gateways:** `TapGateway` / `CheckoutComGateway` (for `SA` tenants), `FawryGateway` (EG reference-pay), `StripeGateway` — each a new `PaymentGateway` implementation, no change to the reconciliation layers, which only ever depend on `processorTxnId` and the settlement contract.
- **Later — integrated POS card terminals:** promote POS `card` from record-only to a captured, gateway-backed tender via the same interface, folding POS card into layer (c) settlement alongside online payments.
- **Owner sign-off required (roadmap open questions #1, #4):** confirm **Paymob** as the first provider before implementation, and confirm whether any tenant runs a physical card terminal that should be integrated (else POS card stays record-only).
