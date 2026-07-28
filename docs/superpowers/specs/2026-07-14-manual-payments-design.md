# ServeOS Payments — Manual-First Foundation — Design

**Date:** 2026-07-14
**Status:** Approved (brainstorming complete)
**Roadmap:** collapses parts of P1 (order payments) + the subscription-billing candidate from
`2026-07-14-vertical-platform-roadmap.md` into one manual-first foundation.
**Scope:** enable real money movement on **both** payment surfaces with **zero payment-gateway
compliance**, via manual "offline payment + proof + confirmation," and leave clean seams so
automated providers (Paymob, Lemon Squeezy) become an upgrade later — not a rewrite.

## 1. Problem & goal

ServeOS has two distinct money flows and today collects money on neither in an automated way:

- **Surface A — order payments** (a tenant's customers → that tenant): only cash-on-delivery
  exists (`orders.paymentMethod = "cash"`, manual `markPaid`).
- **Surface B — subscription billing** (a tenant → ServeOS): plumbing exists (`plans`,
  `subscriptions`, `invoices`, `entitlements`, `BillingProvider` + `ManualBillingProvider`) but
  "upgrade" is a fake note (`requestPlanUpgrade`); nothing charges.

The founder wants to start collecting **now**, **without** the KYC/PCI/tax-registration burden of a
payment gateway or a Merchant of Record — neither of which we can onboard immediately (no business
registration / tax-id yet; MoR seller-KYC is universal). Egypt's dominant consumer rails —
**InstaPay, Vodafone Cash, and mobile wallets** — settle **directly between two accounts**, so a
**manual, proof-based** flow needs no third party and no compliance, and the money lands straight in
the payee's own account.

**Goal:** one shared manual-payments foundation serving both surfaces, direct-to-payee, no
compliance; automated providers deferred behind seams.

## 2. Decisions (from brainstorming)

- **Manual-first, proof-based** for both surfaces now; **Paymob** (Surface A) and **Lemon Squeezy**
  (Surface B) added later as auto-confirm upgrades. ("Both — manual now, provider later.")
- **One shared foundation, phased build.** Build the "offline payment + proof + confirm" capability
  once; apply to Surface A and Surface B.
- **Direct-to-payee.** Surface A money goes to each merchant's own wallet/InstaPay; Surface B to
  ServeOS's own. ServeOS never holds or routes funds → not a payment aggregator, no license.
- **Automation is an upgrade, not a rewrite.** The same records/states can later be flipped to
  `confirmed` by a provider webhook instead of a human.

## 3. Architecture — the shared `offline payments` foundation

New module `src/server/payments/offline/` (framework-agnostic, barrel `index.ts`, matching the
domain-module pattern). It provides the *primitives*; each surface's own domain (ordering, billing)
owns its *records* and its *confirmer* — no polymorphic foreign keys, consistent with ServeOS's
strict-FK + RLS style.

Foundation primitives:
- **`OfflineMethod`** — a configured pay-to channel: `type` (`instapay | vodafone_cash |
  mobile_wallet | bank | cash`), display label, pay-to detail (number / InstaPay address / IBAN),
  `enabled`. Resolved per-surface (see §4).
- **`PaymentProof`** — payer-submitted `reference` (text) + optional `screenshotUrl` (via the
  existing `media-upload`) + `submittedAt`. Informational only — never itself authoritative.
- **Verification state machine** — abstract `awaiting_payment → pending_verification → confirmed |
  rejected`, exposed as a pure helper (`canConfirm`, `canReject`) reused by both surfaces. Each
  surface maps the abstract terminals onto its own concrete columns: Surface A order
  `paymentStatus` (`pending_verification → paid | <order cancelled>`), Surface B invoice
  `status` (`pending_verification → paid | void`). `awaiting_payment` is a transient
  pre-submission UI state, not necessarily persisted.
- **Confirmation authority** — a human confirmer (Surface A: merchant owner/manager; Surface B:
  platform admin) OR, later, a provider webhook. The foundation exposes a single
  `confirm(paymentId, by)` / `reject(...)` seam that both a dashboard action and a future webhook
  call.

The **provider seam**: an optional `AutoConfirmProvider` (Paymob for A, LS for B) can be attached
per surface; when present, its verified webhook calls the same `confirm()` path the human would.
Absence of a provider = pure manual. This is the discipline that makes automation additive.

## 4. Pay-to configuration (who gets paid)

- **Surface A (per-tenant):** each merchant configures their accepted offline methods + pay-to
  details in a new dashboard **Payments** settings tab (mirrors the Taxes tab). Stored in a
  tenant-scoped `tenant_offline_methods` table (RLS). Cash-on-delivery is one such method (no
  pay-to detail). A tenant with none configured keeps today's cash-only behavior.
- **Surface B (platform-level):** ServeOS's own InstaPay/wallet/bank pay-to details, stored in
  platform config (single platform-settings row / env), shown to tenants on the Billing page.

## 5. Data model

Additive; reuses existing columns.

- **`orders` (Surface A):**
  - `paymentMethod` enum `cash` → add `instapay`, `vodafone_cash`, `mobile_wallet` (and later
    `card` for Paymob).
  - `paymentStatus` enum `unpaid | paid` → add `pending_verification` (and later `refund_pending |
    refunded` when Paymob refunds land).
  - add `payment_reference` (text, null), `payment_proof_url` (text, null), `payment_provider_ref`
    (text, null — reserved for Paymob auto-confirm).
- **`invoices` (Surface B):** add `payment_reference`, `payment_proof_url`, `provider_ref` (null).
  `invoiceStatus` `open | paid | void` → add `pending_verification`. `method` reused
  (`instapay | vodafone_cash | bank | ...`).
- **`subscriptions` (Surface B):** add `provider_subscription_id`, `provider_customer_id` (null —
  reserved for LS). `provider` (already exists, `"manual"`) distinguishes manual vs `"lemonsqueezy"`.
- **`plans`:** add `lemon_squeezy_variant_id` (null — reserved for LS Phase).
- **New `tenant_offline_methods`** (Surface A config, RLS): `tenantId`, `type`, `label`, `payToDetail`,
  `enabled`, `sortOrder`.
- **Platform offline-methods config** (Surface B): a platform-settings row (ServeOS pay-to details).
- **Env (reserved, later):** `PAYMOB_*` (Surface A auto), `LEMONSQUEEZY_*` (Surface B auto).

## 6. Surface A flow — store customer order payments

1. **Checkout method choice.** Alongside Cash-on-delivery, the customer picks an enabled offline
   method (Vodafone Cash / InstaPay / wallet). The storefront shows the **merchant's** pay-to detail.
2. **Pay + prove.** Customer pays from their own wallet/bank app, then enters the **transaction
   reference** and optionally uploads a **screenshot**.
3. **Order placed `pending_verification`.** The order is created with `paymentStatus =
   pending_verification`; stock is reserved (existing atomic decrement) so inventory isn't oversold
   while awaiting confirmation. It surfaces in a dashboard **"Awaiting payment confirmation"** queue.
4. **Merchant confirms.** Owner/manager checks their wallet, clicks **Confirm payment** → order
   `paymentStatus = paid`, proceeds through the normal order state machine. **Reject** → order
   cancelled + stock restocked (existing path).
5. **COD unchanged.** Cash orders behave exactly as today.
6. **Paymob later (seam):** a Paymob method auto-confirms via webhook instead of the manual step;
   everything downstream is identical.

## 7. Surface B flow — subscription billing

1. **Plan choice.** On Billing settings the tenant picks a paid plan → an `open` invoice is created
   for the monthly price (`ManualBillingProvider.createInvoice`) and ServeOS's pay-to details show.
2. **Pay + prove.** Tenant pays ServeOS's InstaPay/wallet, submits reference (+ optional screenshot);
   invoice → `pending_verification`.
3. **Admin confirms.** Platform admin verifies receipt → `settleInvoice` marks invoice `paid`,
   subscription → `active` on that plan with a 1-month period; **entitlements update automatically**.
4. **Renewal.** Monthly job opens the next invoice; unpaid past `currentPeriodEnd` → `past_due`
   (existing entitlements gating). Reject → invoice `void`, subscription unchanged.
5. **Lemon Squeezy later (seam):** an LS provider replaces manual with hosted checkout + webhook
   auto-activation + LS's hosted customer portal for card management/cancellation; `provider` flips
   to `"lemonsqueezy"`. Existing manual tenants keep working (coexist via the `provider` column).

## 8. UI / terminology

- **Storefront checkout (A):** a payment-method selector; for offline methods, a "pay to X, then
  enter your reference / upload screenshot" step. Copy is vertical-agnostic.
- **Dashboard (A):** a **Payments** settings tab (configure offline methods + pay-to details); an
  **Awaiting payment confirmation** queue with Confirm / Reject per order (owner/manager only).
- **Billing settings (B):** the existing page gains a real **Subscribe / Change plan** action
  (creates invoice + shows ServeOS pay-to details + proof submission) and the already-present
  invoice history now shows real invoices with status.
- **Platform admin (B):** an invoice-verification queue (Confirm / Reject subscription payments).

## 9. Security

- **Proof is informational, never authoritative** — an order/invoice becomes `paid` only on a
  human confirmation (or, later, a signature-verified provider webhook), never on the
  customer-submitted reference/screenshot alone.
- **RLS** on `orders`, `invoices`, `tenant_offline_methods` (tenant-scoped) as everywhere else.
- **Authorization:** Surface A confirm/reject requires the tenant's `orders:manage` (owner/manager);
  Surface B confirm requires platform super-admin.
- **Screenshot uploads** go through the existing `media-upload` (size/type limits); stored URLs only.
- **Amounts** come from the order/invoice server-side; the payer never sets what they owe.
- **Later automation:** provider webhooks HMAC-verified; webhook is the confirmation authority;
  idempotent on provider ref.

## 10. Error handling

Typed errors (per `src/shared/errors.ts`): `PaymentMethodNotEnabledError` (method not configured
for the tenant), `PaymentAlreadyResolvedError` (confirming/rejecting an already-resolved
payment — idempotent no-op guard), `InvalidProofError` (missing reference when required),
`BillingConfigError` (missing pay-to details / unmapped plan). Confirmation is idempotent: a
double-confirm is a no-op; a reject after confirm is refused.

## 11. Testing

- **Unit:** verification state-machine transitions (`awaiting → pending → confirmed/rejected`, illegal
  transitions rejected); offline-method resolution per surface; proof validation.
- **Integration (Vitest + serveos_test DB):** RLS on `tenant_offline_methods`; Surface A place-order
  with an offline method → `pending_verification` → confirm → `paid` + order proceeds; reject →
  cancelled + restock (concurrency: confirm and reject race → exactly one wins); Surface B
  create-invoice → submit proof → admin confirm → invoice `paid` + subscription `active` +
  entitlements reflect plan; idempotent double-confirm.
- **Restaurant/existing regression:** cash-on-delivery and current order flow byte-identical; a
  tenant with no offline methods behaves as today.
- **Seams:** a **fake `AutoConfirmProvider`** proves the webhook path calls the same `confirm()` as
  the human, so the later Paymob/LS work is a drop-in.

## 12. Phasing (implementation sequence)

1. **Foundation** — `offline payments` module + verification state machine + proof capture + config
   tables.
2. **Surface A** — checkout offline methods + order `pending_verification` + merchant confirm queue.
3. **Surface B** — real manual subscription invoices + admin confirm + subscription activation.
4. **Later (separate sub-projects):** Paymob auto-confirm (A); Lemon Squeezy MoR (B).

## 13. Out of scope

- **Paymob** integration and **Lemon Squeezy** integration themselves (designed-for via the seam;
  each is its own later sub-project — see the roadmap and the LS reference doc).
- Automatic reconciliation with bank/wallet statements (confirmation is human in the manual phase).
- Partial payments, split payments, tips, refunds beyond the existing cancel/restock path.
- Multi-currency (EGP; the pay-to rails are Egyptian).
- ServeOS's own corporate tax/e-invoicing (business/accounting matter, not software scope).
