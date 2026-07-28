# ServeOS — Fiscal Compliance: ETA e-Invoicing & e-Receipts Design

**Date:** 2026-07-24
**Status:** Draft — pending review · **compliance-critical**
**Scope:** Spec 11 of the core POS & operations roadmap (`docs/ROADMAP.md`). It implements locked decision **D8** (`docs/ROADMAP.md:42`): POS + online sales in Egypt are submitted to the **Egyptian Tax Authority (ETA)**; the customer receipt carries the ETA **UUID + QR code**; refunds issue **credit notes** referencing the original document; products carry **EGS/GS1** tax codes. Everything sits behind a `FiscalProvider` interface (mirroring the existing `BillingProvider`) so other tax regimes slot in later, and the whole subsystem is gated on `tenants.country === "EG"`. **Depends on Spec 1 (Sale & Tender)** for the sale/tender it fiscalises and **Spec 3 (Refunds)** for the credit-note trigger. Because it moves compliance data to a government platform, every ETA-specific field, window, and requirement that research could not confirm is flagged in **"Compliance items to VERIFY with ETA"** below rather than guessed.

## Context

ServeOS records a sale through `recordSale` (`src/server/pos/record-sale.ts:51`), which wraps `placeOrder` (`src/server/ordering/service.ts:59`), writes tenders to `order_payments`, an append-only adjustment trail to `pos_adjustment_events`, and guarantees device idempotency via `pos_order_receipts` (`src/server/pos/record-sale.ts:176`). The receipt is rendered by `apps/pos/src/screens/Receipt.tsx` — order number, lines, VAT, tenders, change, cashier — and today carries **no fiscal identifier of any kind**. Products (`src/server/catalog/schema.ts:18`) have `sku`/`brand` but **no tax classification**. Tenants (`src/server/tenancy/schema.ts:13`) already carry `country` (`"EG"`) and `currency` (`"EGP"`), so a country gate is available with no migration.

Egypt runs **two** distinct government systems. The **e-invoice (فاتورة)** system is the B2B pre-clearance regime for VAT-registered businesses; the **e-receipt (إيصال)** system is the B2C/POS-facing regime for consumer sales. A restaurant or retail POS sale is a **B2C e-receipt**; a sale to a business that supplies its tax registration is a **B2B e-invoice** — a retailer typically needs both ([Avalara](https://www.avalara.com/us/en/vatlive/country-guides/africa-and-middle-east/egypt-vat/egyptian-e-invoicing.html), [Wafeq — e-receipt](https://www.wafeq.com/en-eg/tax-and-reporting/e-receipt-system), [flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate)).

| | **e-Receipt (إيصال) — this spec's v1** | **e-Invoice (فاتورة)** |
|---|---|---|
| Party | **B2C** — the consumer at the till/checkout | B2B — a registered business buyer |
| ServeOS trigger | Every POS/online consumer sale | A sale where a buyer supplies a tax registration (deferred trigger) |
| Clearance model | **Post-clearance** — sale completes, submit within the window ([flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate)) | **Pre-clearance** — validated by ETA before finalising ([Avalara](https://www.avalara.com/us/en/vatlive/country-guides/africa-and-middle-east/egypt-vat/egyptian-e-invoicing.html)) |
| Fields | Simplified; QR on the printed copy | Full buyer/seller, itemised, VAT breakdown |
| ServeOS `docType` | `e_receipt` | `e_invoice` (schema-ready, not triggered in v1) |

This is why F4 (async, non-blocking) is safe for v1: the consumer e-receipt is post-clearance, so the till never waits on ETA.

## Problem

An Egyptian POS that does not submit to ETA is illegal to operate for any mandated taxpayer. The B2C e-receipt mandate took effect **15 September 2025** for named taxpayers (ETA Decision No. 281/2025), and the e-invoicing registration threshold was cut from EGP 500,000 to **EGP 250,000** in annual revenue with registration due before **31 March 2026** ([comarch](https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/egypt-expands-e-receipt-requirements-for-b2c-transactions-from-september-2025/), [vatupdate](https://www.vatupdate.com/2025/08/09/egypt-expands-e-receipt-mandate-for-b2c-transactions-starting-september-2025/), [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2025/01/tnf-egypt-taxpayers-required-comply-mandate-electronic-receipts-b2c-transactions.html)). ServeOS has none of the machinery: no per-line tax codes, no taxpayer/device registration, no signing, no submission, no UUID/QR on the receipt, and no credit-note path for a refund. It also must not become a *blocking* dependency of the till — ETA e-receipts allow submission **within a window (up to ~24h) rather than synchronously** ([flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate)), and a cash register that stops selling because a government API is slow is worse than useless.

## Goal

A `FiscalProvider` abstraction whose first implementation is **ETA (Egypt)**, wired so that: (a) every committed POS/online sale in an EG tenant is **enqueued** as an `e_receipt` submission and drained asynchronously with retry (never blocking the sale); (b) once ETA **accepts**, the receipt renders the returned **UUID + QR**; (c) a Spec 3 refund enqueues a **`credit_note`** referencing the original receipt's UUID; (d) each line carries an **EGS/GS1** code and tax type resolved from `product_tax_codes`; (e) submissions emit Spec 4 audit events and raise a Spec 5 notification on repeated failure. Non-EG tenants get a **no-op provider** and see no behavioural change.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| F1 | Provider abstraction | **`FiscalProvider` interface**, shaped like `BillingProvider` (`src/server/billing/provider.ts`) / `PaymentGateway`. First impl `EtaFiscalProvider`; non-EG tenants resolve `NoopFiscalProvider`. Chosen once per request from the tenant's country. |
| F2 | Country gate | **Entire subsystem gated on `tenants.country === "EG"`** (`src/server/tenancy/schema.ts:13`). A non-EG sale writes **no** `eta_submissions` row and the fiscal hook is a no-op. |
| F3 | Document type for POS/online consumer sales | **`e_receipt`** (B2C). `e_invoice` (B2B) is modelled in the schema and provider but only produced when a business buyer + tax registration is supplied (deferred trigger). Restaurant/retail walk-in = `e_receipt`. |
| F4 | Submission timing | **Asynchronous, never blocks the sale.** `recordSale` commits, then enqueues; a scheduled worker submits with retry — reusing the Spec 5 outbox-worker pattern. Justified by ETA's ~24h e-receipt acceptance window ([flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate)). **VERIFY** the exact window and whether any document must be synchronous (see below). |
| F5 | Refund → credit note | A Spec 3 refund on a fiscalised sale enqueues a **`credit_note`** submission referencing the original accepted receipt's `etaUuid`. |
| F6 | Item coding | **`product_tax_codes`** carries the EGS/GS1 (`egsCode`), `taxType`/`taxSubType`, and `unitType` per product; a line cannot be fiscalised without a resolved code. |
| F7 | Credentials | **`eta_tenant_config`** holds registration + client credentials; **the client secret / signing material is encrypted at rest or env-referenced, never plaintext** in the row. `environment` selects preprod vs prod. |
| F8 | Authorization | **New `fiscal:manage` permission (owner only)** for config; **submission itself is a system action** (no user permission), exactly as Spec 5 sending is. |
| F9 | Money convention | Amounts serialise from the existing `money(n)` numeric strings (`src/server/ordering/service.ts:55`); no new arithmetic — the sale total is authoritative and only *mapped* into the ETA document. |

## Non-goals (deferred by explicit decision)

- **B2B e-invoice issuance UI** (entering a business buyer's tax registration at the till) — schema/provider support the `e_invoice` docType, but the trigger and buyer-capture flow are deferred; consumer `e_receipt` is v1.
- **The refund domain itself** → **Spec 3**. This spec only *listens* for `refund.issued` and maps it to a `credit_note`; it does not model refunds.
- **The email/notification transport** → **Spec 5**. This spec *calls* `notify` on repeated submission failure; it builds no send path.
- **The audit chain** → **Spec 4**. This spec *calls* `recordAuditEvent` for submit/accept/reject; it does not build the chain.
- **Non-Egypt tax regimes** (KSA ZATCA, etc.) — the `FiscalProvider` interface is designed to admit them; only ETA is implemented.
- **The e-seal/HSM signing device procurement and PKI** — the code references the signing material and calls the signer; obtaining the certificate/HSM and the ETA-approved signing integration is an operator task (see VERIFY).
- **Reconciling fiscal submissions against ETA settlement/returns filing** → a future reporting concern (Spec 10 may surface submission status).

## Data model

Three new tenant-scoped tables (`FORCE ROW LEVEL SECURITY`, reads/writes through `withTenant`, `src/db/with-tenant.ts`), matching the canonical names in `docs/ROADMAP.md:107`. `eta_submissions` deliberately mirrors the Spec 5 `notification_outbox` shape (status + attempts + lastError) so the same store-and-forward worker semantics apply.

### New: `eta_submissions`

One row per fiscal document sent (or to be sent) to ETA. Offline-resilient: created `pending`, drained and retried by a scheduled worker, terminal at `accepted`/`rejected`.

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `tenantId` | uuid → `tenants.id`, not null; RLS key |
| `docType` | enum `eta_doc_type`: `e_receipt \| e_invoice \| credit_note` |
| `orderId` | uuid → `orders.id`, **nullable** — set for `e_receipt`/`e_invoice` |
| `refundId` | uuid → `refunds.id` (Spec 3), **nullable** — set for `credit_note` |
| `status` | enum `eta_submission_status`: `pending \| submitted \| accepted \| rejected \| failed` |
| `etaUuid` | text, nullable — ETA's document UUID, returned on submit/accept |
| `etaLongId` | text, nullable — ETA's long id (used to build the public QR/verify link) |
| `submissionUuid` | text, nullable — ETA's per-submission (batch) id |
| `qrPayload` | text, nullable — the payload/URL encoded into the printed QR once accepted |
| `hashOrSignature` | text, nullable — the document hash / e-seal signature attached at submit |
| `requestJson` | jsonb — the exact document body sent (forensics + resubmit) |
| `responseJson` | jsonb, nullable — ETA's raw response (validation errors live here) |
| `attempts` | int, default `0` — incremented each submit try |
| `lastError` | text, nullable — last failure/rejection reason |
| `submittedAt` | timestamptz, nullable |
| `acceptedAt` | timestamptz, nullable |
| `createdAt` | timestamptz, default `now()` |

Partial index on `(status, createdAt)` where `status IN ('pending','failed')` — the worker's claim query. Unique index on `(tenantId, docType, orderId)` / `(tenantId, docType, refundId)` so a retried enqueue never doubles a document.

### New: `product_tax_codes`

The per-product fiscal classification ETA requires on every line. One row per product; a line without a resolvable code cannot be fiscalised.

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `tenantId` | uuid → `tenants.id`, not null; RLS key |
| `productId` | uuid → `products.id` (`src/server/catalog/schema.ts:18`), unique per tenant |
| `egsCode` | text — the **EGS** (Egyptian GS1) / GS1 **GPC** item code ([GS1 Egypt — EGS](https://gs1eg.org/en/tools/eta-free-egs/)) |
| `taxType` | text — ETA tax type (e.g. VAT `T1`) — **VERIFY code list** |
| `taxSubType` | text, nullable — ETA tax sub-type where the type requires one |
| `unitType` | text — ETA unit-of-measure code (e.g. `EA`) |
| `createdAt` | timestamptz, default `now()` |

### New: `eta_tenant_config`

One row per EG tenant: registration + credentials + environment. **Secrets are never stored in plaintext** (F7): `clientSecretRef`/`signingKeyRef` hold an env/secret-manager reference or a value encrypted at rest, resolved server-side at submit time.

| Column | Notes |
|---|---|
| `id` | uuid, pk |
| `tenantId` | uuid → `tenants.id`, not null, unique; RLS key |
| `registrationNumber` | text — the taxpayer **RIN** / tax registration number |
| `clientId` | text — ETA-issued API client id for the registered POS/ERP system |
| `clientSecretRef` | text — **reference to** the encrypted client secret (env/secret-manager key), not the secret |
| `signingKeyRef` | text, nullable — reference to the e-seal signing material (HSM slot / cert alias) |
| `environment` | enum `eta_environment`: `preprod \| prod` |
| `activationStatus` | enum `eta_activation_status`: `not_configured \| pending \| active \| suspended` |
| `createdAt` | timestamptz, default `now()` |

## Provider setup [what the owner must supply]

ETA onboarding is a per-tenant operator task; the code cannot self-provision it. Before an EG tenant's `activationStatus` can go `active`, the owner (or the platform on their behalf) must, **once**:

1. **Register as a taxpayer on the ETA portal** and confirm the business is on the **obligated-taxpayer list** (VERIFY item 7). This yields the **RIN** / tax registration number → `eta_tenant_config.registrationNumber`.
2. **Register the POS/ERP as a connected system** to obtain **API client credentials** (OAuth 2.0 client-credentials) → `clientId` + the encrypted `clientSecretRef`. Then **register and activate each POS device by its serial number**, linked to the RIN + branch — unregistered devices are rejected by ETA ([flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate), [cleartax](https://www.cleartax.com/eg/en/e-invoicing-egypt)).
3. **Obtain the e-seal signing material** — an ETA-approved certificate on an HSM / cloud signing service (or USB token for low volume) → `signingKeyRef`. Whether e-receipts require this is VERIFY item 2; the field is provisioned regardless.
4. **Classify the catalog** — every sellable product needs an **EGS/GS1 (GPC)** code, an ETA tax type/sub-type, and a unit code in `product_tax_codes`. ETA/GS1 Egypt provide a free EGS lookup ([GS1 Egypt — EGS](https://gs1eg.org/en/tools/eta-free-egs/)); a line with no code fails its document (never the sale).
5. **Choose `environment`** — validate end-to-end against **preprod** first, flip to **prod** at go-live. The active provider reads credentials from the secret store keyed by the refs above; no secret is ever stored in a table row (F7).

The submit client sends **From** the tenant's registered RIN/client id over TLS; a slow or failed ETA never blocks a sale (F4), so misconfiguration surfaces as `pending`/`failed` submissions plus an owner notification rather than a broken till.

## Authorization

- **`fiscal:manage`** (new entry in `src/server/rbac/permissions.ts`, alongside the Fiscal permissions) gates reading/writing `eta_tenant_config` and viewing submission status. **Owner only** by default (managers do not touch tax credentials). It is added to the `owner` array in `ROLE_PERMISSIONS`.
- **Submission is a system action** with **no user permission** (F8): the worker enqueues and drains inside domain events, exactly as Spec 5's `notify`/outbox sending needs no RBAC grant — the authorised action (recording the sale) already happened.
- All three tables are **tenant-scoped, FORCE RLS**; reads/writes go through `withTenant`, so cross-tenant fiscal data is impossible. `eta_tenant_config` credentials are only ever resolved server-side inside the provider; they are never returned to any client (the config API returns `activationStatus` and masked identifiers only).

## API

- **`FiscalProvider` interface** (`src/server/fiscal/provider.ts`) — shaped like `BillingProvider`:
  ```
  export interface FiscalProvider {
    readonly name: string;                                  // "eta" | "noop"
    buildReceipt(input: FiscalSaleInput): FiscalDocument;   // pure: sale → ETA document
    buildCreditNote(input: FiscalRefundInput): FiscalDocument; // pure: refund → credit note
    submit(doc: FiscalDocument, cfg: EtaConfig): Promise<FiscalSubmitResult>;
  }
  ```
  `FiscalSubmitResult` = `{ status, etaUuid?, etaLongId?, submissionUuid?, qrPayload?, hashOrSignature?, responseJson }`. `build*` are **pure** (mappers, unit-testable offline); `submit` performs the signed HTTP call. First concrete: `EtaFiscalProvider`; `NoopFiscalProvider.submit` returns a `skipped` result and writes nothing. Re-exported from `src/server/fiscal/index.ts`; `resolveFiscalProvider(tenant)` picks ETA for `country === "EG"`, else the no-op.
- **`enqueueFiscalDocument(ctx, { docType, orderId?, refundId? }, tx?)`** — the core surface, **not HTTP**. Inserts a `pending` `eta_submissions` row **inside the caller's transaction** so the fiscal enqueue commits atomically with the sale/refund (or not at all). Called from `recordSale` after the sale commits and from Spec 3 `issueRefund`.
- **`drainEtaSubmissions()`** — the scheduled worker (mirrors Spec 5's outbox worker): claims `pending|failed` rows (`SELECT … FOR UPDATE SKIP LOCKED`, backoff-eligible), builds + signs + `submit`s, records `etaUuid`/`qrPayload`/`status`, increments `attempts`, and on terminal failure raises a Spec 5 `notify`. Idempotent per row.
- **`GET /api/pos/v1/sales/:orderId/fiscal`** — POS reads the current submission status + `etaUuid`/`qrPayload` for the receipt (device-auth, `pos:sell`). Returns `{ status, etaUuid, qrPayload }` or `null` while pending.
- **`GET /api/dashboard/fiscal/config` · `PUT /api/dashboard/fiscal/config`** — owner-only (`fiscal:manage`), via `withTenant`: read masked config + activation status; set `registrationNumber`/`clientId`/secret refs/`environment`. Never echoes secrets.
- **`recordSale` hook** (`src/server/pos/record-sale.ts`): after the existing `pos_order_receipts` insert commits, and only when `resolveFiscalProvider(tenant).name === "eta"`, call `enqueueFiscalDocument(ctx, { docType: "e_receipt", orderId })`. The sale return value is **unchanged** — the receipt payload gains a nullable `fiscal` block the POS polls/refreshes.
- **`apps/pos/src/screens/Receipt.tsx`**: when the fiscal block resolves to `accepted`, render the **ETA QR** (from `qrPayload`) and the **UUID** (`etaUuid`) in a fiscal footer; while `pending`/`submitted` show "Fiscal receipt pending"; on `rejected` show a non-blocking notice (the sale still stands — the fix is a resubmit, not a re-sale).

## Architecture

```
  POS / online sale                     Spec 3 refund (issueRefund)
        │  recordSale() commits                │  commits
        │  (sale is DONE — never blocked)      │
        ▼                                      ▼
  enqueueFiscalProvider gate: tenant.country === "EG" ?  ── no ──►  NoopFiscalProvider (nothing written)
        │  yes
        ▼
  enqueueFiscalDocument(ctx, {docType, orderId|refundId}, tx)   ← inside the caller's transaction
        │   INSERT eta_submissions (status='pending', attempts=0, requestJson=…)
        ▼
  ┌──────────────── drainEtaSubmissions()  (scheduled worker) ─────────────────┐
  │ claim pending|failed  (FOR UPDATE SKIP LOCKED, backoff-eligible)            │
  │ resolve EtaConfig (decrypt clientSecretRef / signingKeyRef server-side)     │
  │ build:   provider.buildReceipt | buildCreditNote  → FiscalDocument          │
  │ sign:    attach e-seal / document hash  → hashOrSignature                   │
  │ submit:  provider.submit(doc, cfg)  ──► ETA API (OAuth2 client-credentials) │
  │   on accept:  etaUuid, etaLongId, qrPayload, status='accepted', acceptedAt  │
  │   on reject:  status='rejected', responseJson=errors, lastError            │
  │   on error:   attempts++, status='failed', backoff; give up after N → notify│
  │ recordAuditEvent(ctx, 'eta.submission.{submitted|accepted|rejected}', tx)   │
  └──────────────────────────────────────────────────────────────────────────────┘
        │  status='accepted' (etaUuid + qrPayload persisted)
        ▼
  GET /api/pos/v1/sales/:orderId/fiscal  ──►  Receipt.tsx renders  [ QR ]  UUID: <etaUuid>
```

The offline queue **is** `eta_submissions`: a sale during an ETA outage (or a POS internet drop, once offline-first lands) commits locally as `pending` and drains when connectivity returns — the sale never waits on the government. Terminal `failed`/`rejected` rows surface as a Spec 5 `critical` notification to the owner so a broken code or dead credential gets fixed, not silently swallowed.

## Error handling / edge cases

- **ETA down / timeout:** the sale already committed; the row stays `pending`/`failed` and the worker retries with backoff. Selling continues.
- **Rejection (bad EGS code, tax mismatch, expired cert):** `status='rejected'`, ETA errors captured in `responseJson`/`lastError`; owner is notified; the sale stands and a corrected document is resubmitted (new attempt on the same row).
- **Missing `product_tax_codes` for a line:** the document cannot be built — the row goes `failed` with a clear `lastError` naming the product, and the owner is alerted to classify it. The **sale is never blocked** by an unclassified item.
- **Missing / inactive `eta_tenant_config`:** an EG tenant with `activationStatus != active` enqueues rows that stay `pending` (durable) and the setup is flagged; nothing is submitted until config is active — no undeliverable spray at ETA.
- **Refund before the original receipt is accepted:** the `credit_note` enqueue waits (or the worker defers it) until the parent `e_receipt` has an `etaUuid` to reference; a credit note with no parent UUID is never submitted.
- **Duplicate enqueue (retried sale/refund):** the unique index on `(tenantId, docType, orderId|refundId)` makes the second insert a no-op — one document per order/refund, exactly as `pos_order_receipts` guarantees one sale.
- **Non-EG tenant:** no row, no provider call, no receipt change — proven by the country gate test.
- **Worker crash mid-submit:** `etaUuid`/`submissionUuid` are written before `accepted`; a reclaim re-queries ETA by `submissionUuid` (or resubmits with the same idempotency key) rather than blindly re-sending, so a document is never double-registered. **VERIFY** ETA's resubmit/idempotency semantics.
- **Receipt reprint (Spec 3):** a reprint renders the **stored** `etaUuid`/`qrPayload` — it never re-submits.
- **Tenant flips `country` after sales exist:** the gate is evaluated per sale at enqueue time, so historical non-EG sales are never retro-submitted; only sales after the flip (with active config) fiscalise.
- **Partial refund → credit note amount:** the `credit_note` reflects only the returned lines/amount from the Spec 3 `refund`, not the whole receipt; multiple partial refunds against one receipt produce multiple credit notes, each referencing the same parent `etaUuid`.
- **Config edited mid-flight:** a credential/environment change does not mutate already-`accepted` rows; in-flight `pending`/`failed` rows pick up the new config on their next attempt (secrets resolved at submit time, not at enqueue).
- **Zero-rated / exempt line:** still requires a `product_tax_codes` row (the tax type encodes the exemption); a missing row is treated as unclassified, not as zero tax.

## Testing

- **Unit (pure):** `buildReceipt` maps a fixture sale → the ETA document shape with correct per-line EGS code, tax type/subtype, unit, and totals derived from `money(n)` strings; `buildCreditNote` references the parent `etaUuid` and negates the returned lines; `NoopFiscalProvider.submit` returns `skipped`.
- **Country gate (server):** an EG sale enqueues exactly one `pending e_receipt`; a non-EG sale enqueues **none** and the receipt payload has no `fiscal` block.
- **Worker (Vitest):** `drainEtaSubmissions` claims a row (`SKIP LOCKED`), calls a stubbed `EtaFiscalProvider`, records `etaUuid`/`qrPayload` and flips to `accepted`; a rejection captures `responseJson` and flips to `rejected`; a transient error advances `attempts`/backoff and gives up after N with a Spec 5 `notify`; concurrent workers never submit the same row twice.
- **Refund → credit note:** a Spec 3 refund on an accepted receipt enqueues a `credit_note` referencing the parent `etaUuid`; a refund on a not-yet-accepted receipt defers rather than submitting an orphan.
- **Missing tax code:** a line with no `product_tax_codes` row fails the build with a product-naming `lastError` and does **not** block or roll back the sale.
- **Idempotency:** a re-enqueue for the same `(orderId, docType)` is a no-op (unique index); reprint renders stored UUID/QR with no new submission.
- **Audit:** submit/accept/reject each emit the corresponding `recordAuditEvent` in the worker's transaction.
- **Renderer:** `Receipt.tsx` shows the QR + UUID only when `accepted`, "pending" while in flight, and a non-blocking notice on `rejected`.
- **Secrets:** the config API never returns `clientSecretRef`/`signingKeyRef` values; RLS blocks cross-tenant reads of all three tables.
- **Config gate:** an EG tenant with `activationStatus != active` enqueues rows that stay `pending` and are never submitted; flipping to `active` lets the next worker pass drain them.
- **Money mapping (parity):** the document total mapped by `buildReceipt` equals the sale's `orders.total` to the cent for a fixture with discounts, VAT, and a service charge — no second arithmetic is introduced (F9).

## Compliance items to VERIFY with ETA

These are **not confirmed** by public research and must be checked against the current ETA developer portal / SDK before build. Each is load-bearing for legality.

1. **Submission window & synchronicity (highest risk).** Sources conflict: some describe e-receipts as **real-time/synchronous**, others cite an acceptance window of **up to 24 hours**, and at least one earlier source said **72 hours** ([Wafeq](https://www.wafeq.com/en-eg/tax-and-reporting/e-receipt-system), [flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate)). Decision F4 (async, non-blocking) depends on this. **Confirm the exact window, any "late submission" process, and whether any document type must be submitted synchronously before the receipt is handed over.**
2. **Digital signature / e-seal requirement for e-receipts.** The e-seal (HSM or USB token) is clearly mandatory for **B2B e-invoices**; for **B2C e-receipts** sources disagree — one states each submission must be signed with the taxpayer's e-seal ([flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate)), others imply POS e-receipts submit without it ([cleartax](https://www.cleartax.com/eg/en/e-invoicing-egypt)). **Confirm whether e-receipts require the e-seal, whether a cloud/HSM signing service is required for automated volume, and the exact signing algorithm/canonicalisation** — this drives `signingKeyRef` and `hashOrSignature`.
3. **Credit-note mechanism for e-receipts specifically.** Credit/debit notes referencing the original UUID are documented for **e-invoices** ([orchidatax](https://orchidatax.com/eta-e-invoicing-egypt-faq/)); the e-receipt equivalent (document type name, whether a full cancellation vs a credit note, and the reference field) is **not** clearly documented. **Confirm how a refund is represented on the e-receipt system and the exact reference to the original receipt.**
4. **Tax type/sub-type code list.** The EGS/GPC item coding is confirmed ([GS1 Egypt](https://gs1eg.org/en/partners/eta/)), but the ETA **tax type/sub-type** code table (VAT `T1`, table tax, exemptions) and required **unit-of-measure** codes were not retrievable. **Obtain the current code lists for `product_tax_codes`.**
5. **QR payload format.** That a QR must appear on the printed customer copy and encodes a link to the receipt record is confirmed; the **exact payload structure** (signed TLV vs a verify URL built from `etaLongId`) is not. **Confirm the encoding** before implementing `qrPayload` rendering in `Receipt.tsx`.
6. **Authentication details.** OAuth 2.0 **client-credentials** and per-POS device registration by serial number linked to the RIN + branch are confirmed ([flick.network](https://www.flick.network/en-eg/egypt-b2c-e-receipt-mandate)); the **token TTL, refresh cadence, per-device vs per-system credential granularity, and preprod base URLs** need confirming for `eta_tenant_config` + the submit client.
7. **Mandate applicability to this tenant.** Scope is **taxpayer-list based** (ETA Decision 281/2025, effective 15 Sept 2025) plus the **EGP 250,000** registration threshold (register before 31 Mar 2026) ([comarch](https://www.comarch.com/trade-and-services/data-management/legal-regulation-changes/egypt-expands-e-receipt-requirements-for-b2c-transactions-from-september-2025/), [datavalue](https://datavalue.solutions/egypt-e-invoicing-eta-2026-sme-guide/)). **Each tenant must verify inclusion on the ETA obligated-taxpayer list**; `activationStatus` gates submission until they do.

## Roadmap

- **Built on — Spec 1 (Sale & Tender):** `recordSale`, `order_payments`, `pos_order_receipts` idempotency, and the receipt payload the fiscal block extends.
- **Built on — Spec 3 (Refunds & Sales History):** `issueRefund` / `refunds` trigger the `credit_note`; reprint renders the stored UUID/QR.
- **Uses — Spec 4 (Audit):** submit/accept/reject emit `recordAuditEvent`; no chain change.
- **Uses — Spec 5 (Notifications):** repeated submission failure raises a `critical` `notify` to the owner; reuses the outbox-worker store-and-forward pattern for `drainEtaSubmissions`.
- **Catalog surface (later):** an owner UI to bulk-assign `product_tax_codes` (EGS lookup) alongside `menu:manage`.
- **B2B e-invoice (later):** the `e_invoice` docType is schema-ready; capturing a business buyer's tax registration at the till turns it on.
- **Other regimes (later):** a second `FiscalProvider` (e.g. KSA ZATCA) proves the interface; the country gate already routes by `tenants.country`.
</content>
</invoke>
