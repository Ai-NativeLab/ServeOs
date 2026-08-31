# ETA Spec 11 — Verified-Findings Addendum (2026-08-30)

**Status:** Authoritative delta over `2026-07-24-eta-einvoicing-and-ereceipts-design.md` and its plan.
Where this addendum and the original spec/plan disagree, **this addendum wins.**

Every claim below was verified 2026-08-30 against official pages — eta.gov.eg, sdk.invoicing.eta.gov.eg,
pos.eta.gov.eg, itida.gov.eg — with verbatim quotes now captured durably in
`docs/references/eta/regulations.md` (the full regulatory research + evidence classification). Primary-source PDFs are
in `docs/references/eta/` (see its README). Secondary/vendor claims are marked `[S]`; everything else is official.

## 1. Corrections to the original spec

| # | Original claim | Verified correction |
|---|---|---|
| C1 | "Threshold cut EGP 500k → 250k, register by 31 Mar 2026" | **False.** ETA FAQ still states the EGP 500,000 VAT registration threshold. Decision 281/2025 is an e-receipt **wave** decision (8th stage, sub-phase 2, eff. 15 Sep 2025) with no threshold content. Mandate basis: named-taxpayer wave decisions (latest verified **361/2025**, eff. 15 Nov 2025) + economic forcing (VAT deduction e-invoice-only since 1 Apr 2023; cost recognition since 1 Jul 2023; Law 6/2025 simplified regime conditional on both systems). |
| C2 | `etaUuid` "returned on submit/accept" | For **e-receipts the client computes the UUID**: SHA-256 hex(64) of the canonically serialized receipt, **chained via `previousUUID`** to the prior receipt of the *same POS device* (empty string only for the device's first receipt). ETA returns `longId` on acceptance. (B2B e-invoices: ETA assigns UUID + longId — unchanged.) |
| C3 | Rejection → "corrected document resubmitted (new attempt on the same row)" | A corrected receipt is a **new document** with a **new UUID** (still chained) carrying `referenceOldUUID` of the rejected one — a new `eta_submissions` row, never a mutation of the old. |
| C4 | Refund → generic `credit_note` | On the e-receipt system a refund is a **Return Receipt** referencing the original receipt's UUID, allowed within **540 days** of the sale receipt. `credit_note` remains only for the deferred B2B e-invoice docType. |
| C5 | QR rendered "once ETA accepts" | QR is **locally constructible at issuance**: `{portal}/receipts/search/{UUID}/share/{dateUTC}#Total:{total},IssuerRIN:{rin}`. The printed customer copy must carry it at sale time (post-clearance model); submission status is a separate, later indicator. |
| C6 | One tenant-level API credential | e-Receipt submission authenticates **per POS device**: each registered device (by serial, at pos.eta.gov.eg, linked to the RIN + branch) gets its own Client ID + Secret 1/2, and tokens require headers `posserial`, `pososversion`, `posmodelframework`, `presharedkey`; token TTL **3600 s**; the taxpayer profile must carry the **B2C tag**. Tenant-level (ERP) credentials remain for B2B invoices and the codes APIs. |
| C7 | e-seal possibly required for B2C | **Not today.** Receipt batch-signature validation "will not be deployed at this point until a decision is provided by ETA" (SDK, verbatim). CAdES-BES + ITIDA-licensed e-seal is required only for B2B e-invoice v1.0 (v0.9 = same schema, signature validation disabled). Keep `signingKeyRef` provisioned but unused for receipts. |

## 2. Schema deltas for Task 1 (additive to the plan's code block)

- **Enum `eta_doc_type` gains `return_receipt`** → `e_receipt | e_invoice | credit_note | return_receipt`.
- **New table `eta_device_chains`** — per-device UUID chain head (the e-receipt analogue of an ICV/PIH chain):
  `id` uuid pk · `tenantId` FK tenants (RLS key) · `deviceId` FK `pos_devices` unique per tenant ·
  `lastUuid` text (64-hex, nullable — null until first receipt) · `lastIssuedAt` timestamptz · `updatedAt`.
  Advance must be concurrency-safe: claim the device row `FOR UPDATE` (or advisory-lock on deviceId) when
  assigning `previousUUID`, so two concurrent sales on one device never share a predecessor.
- **New table `eta_pos_credentials`** — per-device ETA API identity:
  `id` uuid pk · `tenantId` FK (RLS key) · `deviceId` FK `pos_devices` unique per tenant ·
  `etaSerial` text (the serial registered at pos.eta.gov.eg, ≤100 chars) · `clientId` text ·
  `clientSecret1Ref` / `clientSecret2Ref` text (secret-manager refs, NEVER values) ·
  `presharedKeyRef` text · `posOsVersion` text · `posModelFramework` text ·
  `activatedAt` / `expiresAt` timestamptz nullable · `status` enum (`registered | active | expired | retired`) · timestamps.
- **`product_tax_codes` gains** `codeSource` (`gs1 | egs`) and nullable `egsApprovalStatus` text —
  EGS codes must be submitted for ETA approval (codes API) before use in documents; GS1 codes need none.
- **`eta_submissions` gains** `referenceOldUuid` text nullable (C3) and its `docType` accepts `return_receipt`.
  Semantics note: for receipt docTypes `etaUuid` = the **self-computed** UUID (known pre-submit); `etaLongId` = ETA's.
  Unique indexes are partial on `status <> 'rejected'` so a corrected resubmission (C3) is a new legal row;
  enqueue conflict-targets must include the predicate.
  **Post-review hardening (2026-08-30 quality pass):**
  - `nextAttemptAt` backoff clock added (mirrors `notification_outbox`); claim index reshaped to `(status, nextAttemptAt)`.
  - Second partial-unique pair, `WHERE referenceOldUuid IS NULL`, on `(tenantId, docType, orderId|refundId)` — caps the ORIGINAL document at one forever; the `status <> 'rejected'` pair still caps live docs at one.
  - Plain lookup indexes on `(tenantId, orderId)` / `(tenantId, refundId)` — full-history reads must see rows the partial indexes hide.
  - Unique `(tenantId, etaUuid) WHERE etaUuid IS NOT NULL` for fiscal-identity uniqueness.
  - `eta_submissions_parent_xor` CHECK now enforces the docType→parent split in the DB (was writer-trusted).
  - `orderId`/`refundId` FKs changed `cascade` → `restrict` (5-year statutory retention); `eta_device_chains.deviceId` likewise restricted so deleting a device can't silently reset its chain head.
- `eta_tenant_config` unchanged except a comment: its `clientId`/`clientSecretRef` are the **ERP-level** credential.

## 3. Wire facts for Tasks 3/5/7 (previously TODO(VERIFY), now specifiable)

- **Document:** Receipt **v1.2 JSON**; `documentType` sale vs return-receipt variants; buyer types `B`/`P`/`F`
  (buyer ID mandatory for `B`, and for `P` above a configured amount — doc example EGP 150,000); items coded
  **GS1 or EGS**; `dateTimeIssued` UTC, never future.
- **UUID:** SHA-256 of ETA's canonical serialization (algorithm published in the SDK; ETA ships an offline
  toolkit — Docker/NuGet/CLI with `uuid`, `qrcode`, local validators — use it for golden tests with zero credentials).
- **Auth:** OAuth2 client-credentials at `POST {id}/connect/token` (prod `id.eta.gov.eg`, preprod
  `id.preprod.eta.gov.eg`), scope `InvoicingAPI`; e-receipt tokens add the four POS headers (C6). 1h TTL.
- **Submit:** `POST /api/v1/receiptsubmissions` (JSON only) → HTTP **202** + `submissionUUID` with per-receipt
  accept/reject; poll **Get Receipt Submission** for terminal status → worker gains a poll phase between
  `submitted` and `accepted|rejected`.
- **Window:** submit within **24 hours** of issuance; beyond it, the formal **Late Submission Request** path
  (configurable "Late Submission Window (Days)"). Retry/backoff must respect the 24h budget and flag breaches.
  **As built:** the budget is respected by arithmetic (six attempts on a 2^n x 30s backoff span ~31 minutes — the 6th backoff is never served, far
  inside 24h) and the breach is FLAGGED AT THE READ LAYER, not enforced at the worker — stopping retries at the
  deadline would turn a late document into no document. `SUBMISSION_WINDOW_MS` (`fiscal/constants.ts`) is the
  threshold; `listSubmissions`/`getSubmissionById` return `overdue: boolean` and the fiscal dashboard shows each
  submission's age with an overdue marker.
- **QR:** the C5 format string, rendered at issuance.
- **Returns:** Return Receipt referencing the original UUID, ≤ **540 days**.
- **Environments:** APIs `api[.preprod].invoicing.eta.gov.eg`; **preprod TLS chains to ETA's internally-issued
  Root CA** — the submit client must trust it (config/env, never `NODE_TLS_REJECT_UNAUTHORIZED=0`).
- **Rate limits:** per-ERP/POS selective throttling; 429 + `Retry-After`; `X-Rate-Limit-*` headers.
- **Retention:** Law 206/2020 Art. 38 — keep documents (incl. invoice copies) **5 years**; `requestJson`/`responseJson` satisfy this.
- **Contract note:** `FiscalDocument` carries semantic money fields (`subtotal` / `discountTotal` / `feesTotal` / `taxTotals` + per-line `discountAmount` / `taxes`) mapped verbatim from the order's stored figures (F9); `EtaFiscalProvider` owns the mapping to receipt v1.2 wire names.

## 4. Registration boundary (why prod stays gated)

Preprod + production credentials exist only inside a registered taxpayer profile (tax-office enrollment with
original documents, or e-seal-signed online self-registration; ITIDA issues e-seals only with a commercial
registry ≤3 months old — sole proprietors without one are legally excluded). No public developer sandbox exists.
Everything in this addendum is therefore buildable and toolkit-verifiable offline, but `activationStatus`
stays `not_configured|pending` until a real tenant registers; VERIFY 7 (per-tenant obligation, via ETA's RIN
inquiry tool) remains an operational check, not a build blocker.

## 5. VERIFY ledger

| Plan item | Status |
|---|---|
| 1 Submission window / synchronicity | **RESOLVED** — 24h, async 202+poll, Late Submission path (§3) |
| 2 e-seal for B2C | **RESOLVED** — not enforced today (C7) |
| 3 e-receipt refund mechanism | **RESOLVED** — Return Receipt, 540 days (C4) |
| 4 Tax-type / unit code lists | **RESOLVED** — SDK `/codes/` endpoints (tax-types, unit-types, …) |
| 5 QR payload | **RESOLVED** — C5 format, local render |
| 6 Auth details | **RESOLVED** — C6 + §3 |
| 7 Per-tenant applicability | **OPERATIONAL** — RIN inquiry tool per tenant; not a build blocker |
| 8 Resubmit / idempotency | **RESOLVED** — C3 (`referenceOldUUID`, new UUID) + poll by `submissionUUID` |
| 9 uuid blanking rule | **OPEN** — FAQ vs core-fields validator disagree on whether the uuid key is blanked or dropped; one line in `computeReceiptUuid`. See §6. |
| 10 Offline issuance without QR | **OPEN** — an EG offline/unsynced sale prints with no QR (the chain is computed server-side at sync); the reprint carries it once synced. Whether handing the customer a QR-less copy at sale time is compliant is an ETA/tax-adviser question (ETA's own offline toolkit implies local issuance is the sanctioned model); mirrors ZATCA PRD-003 Q3. Raised by Task 7 (POS receipt footer). |

## 6. Wire-level findings (Task 3a, verified against SDK)

Sources: `/document-serialization-approach/`, `/documents/receipt-v1-2/`, `/documents/return-receipt-v1-2/`,
`/receiptissuancefaq/`, `/main-calculations/`, `/codes/payment-methods/`, `/files/one-doc*.json`,
`/files/BatchReceipt.json`.

- **Returns are POSITIVE amounts.** Return Receipt v1.2 is its own document type: `receiptType` `"r"`,
  `typeVersion` `"1.2"`, plus a Mandatory `referenceUUID` naming the sale receipt. Its totals are described in
  the same words as the sale receipt and no negative-amount convention is published anywhere. The plan's
  "negate the credit-note lines" text is **dead**.
- **`feesAmount` / `adjustment` accept only zero.** Stated twice on both document pages. ServeOS's service
  charge and delivery fee therefore ship as their **own `itemData` lines** (decision), classified by a
  per-tenant `FeeLineConfig`; a non-zero fee with no config is a `FeeLineConfigMissingError`, never a dropped
  charge. The wire's `feesAmount`/`adjustment` are hard-wired to `0.00`.
- **Per-line VAT allocation (decision).** ETA validates tax per line — the full published equation is
  `taxableItems[T1].amount = (t2Amount + netSale + TotalTaxableFees[T5-T12] + valueDifference + t3Amount) * rate / 100`,
  which reduces to `netSale * rate / 100` for ServeOS today because we emit no T2/T3 line taxes, no T5-T12
  taxable fees and no `valueDifference` — and `totalAmount = Sum(itemData.total) - Sum(extraReceiptDiscountData.amount) + adjustment`,
  but ServeOS stores VAT once per order. `orders.vatAmount` is therefore split across the taxed lines by
  **largest remainder over scaled BigInt** (never floats). Invariants enforced in code and tests: the parts sum
  to `orders.vatAmount` exactly, and the emitted document satisfies ETA's `totalAmount` equation to the cent.
  Consequences: the **order-level discount is pushed down onto the lines** it actually reduced (ServeOS
  discounts *before* VAT, whereas `extraReceiptDiscountData` is subtracted *after* tax, so reporting it at
  receipt level would misstate the tax base); the **delivery fee line carries no `taxableItems`**, because
  `computeOrderTotals` adds it after VAT and a zero T1 entry would fail the per-line rule. VAT-inclusive orders
  derive a net `unitPrice` at the 5 decimals ETA permits; figures matching neither convention raise
  `IrreconcilableOrderError`. *Alternative deferred as a product decision: store per-line VAT at the ordering
  layer, which would remove the allocation entirely.*
- **No VAT is reversed on returns — LIVE FISCAL EXPOSURE, routed to coordinator for a Spec 3 follow-up.**
  `refunds` stores only `totalAmount`; `refund_lines` stores only `quantity` + `amount`. Neither table holds a
  VAT amount, rate or per-line tax split (verified: zero `vat`/`tax` columns in `src/server/pos/refund-schema.ts`),
  so there is nothing to allocate and deriving a reversal in the fiscal layer would be inventing tax. Return
  receipts therefore declare `netAmount == totalAmount` with no `taxableItems`, which means **a tenant issuing
  returns over-declares output VAT**: the sale's VAT was reported in full and none is credited back. Fixing it
  properly needs VAT figures persisted at the refund layer (a `refunds.vatAmount` + per-line split, or a
  documented re-derivation from the parent order), after which the same largest-remainder machinery and the
  same exact invariants apply unchanged. Plan-level decision, not a mapper change.
- **Wire-boundary fail-closed guards.** The mapper refuses rather than emits a document it cannot total
  correctly: `UnsupportedTaxTypeError` for **T4** (ETA's line-total equation SUBTRACTS T4 where every other
  type is added — withholding support is deliberate work, so T1/T2/T3/T5-T20 are allowed and T4 is rejected);
  `BuyerIdRequiredError` for a `B` buyer or a `P` buyer at/above the threshold with no `buyer.id`;
  `EmptyReturnReceiptError` for a header-only full refund (`issueRefund` inserts `refund_lines` only when the
  caller names them, but `itemData` is Mandatory); and `EtaTotalsMismatchError` for `totalAmount`,
  `taxTotals<taxType>` and `totalSale = quantity * unitPrice`. `unitPrice` is always DERIVED from the line's
  own `totalSale`, never copied from `order_items.unitBasePrice` — that column excludes modifier price deltas
  for a plain product line while `lineTotal` includes them, so a passthrough broke the equation on any
  modified line.
- **Golden vector in CI.** ETA's published serialization example (`one-doc.json` + `one-doc-serialized.json.txt`,
  committed verbatim under `src/server/fiscal/__fixtures__/` with their source URLs) is asserted byte-for-byte
  against the real serializer on every run.
- **Contract changes were BREAKING, not additive** (honest correction): `FiscalDocument.paymentMethodCode`,
  `FiscalSaleInput.payments` and `FiscalRefundInput.items` are all REQUIRED fields, so every implementer of
  `FiscalProvider` must supply them. Blast radius was zero — the only call sites were inside
  `src/server/fiscal/` — because Task 4 has not wired the sale/refund paths yet. `FiscalDocLine.internalCode`
  and `FiscalSaleInput.feeLines` are genuinely additive (optional).
- **VERIFY-9 (OPEN): uuid blanking rule.** The FAQ says the receipt "has empty receipt UUID" and that
  serialization flattens "all its properties" (implemented: the `uuid` key is kept with an empty value, so the
  hashed text contains `"UUID"""`), while the core-fields validator says "excluding the UUID itself", which
  could mean dropping the property — **a different hash**. ETA's own sample receipt carries a placeholder uuid,
  so it cannot settle it. One line in `computeReceiptUuid`; confirm against preprod once a registered profile
  exists.
- **Buyer id threshold: 150,000 EGP** for `type` `P` in v1.2 (50,000 for 1.0–1.1). Above it `buyer.id` + `name`
  become Mandatory and Main Calculations requires a **14-digit** national ID (`seller.rin` must be 9 digits).
  The walk-in default would be rejected above the threshold.
- **Payment method is a single code, not a list.** `paymentMethod` is String(50); a split payment resolves to
  the largest tender. Mapping to `/codes/payment-methods/`: `cash` → `C` (Cash), `card` → `V` (Visa — the
  table's only card row), everything else → `O` (Others). Web orders have no `order_payments` rows and fall
  back to `orders.paymentMethod`.
- **Task 6 config inputs now known:** `seller.activityCode`; a **structured `branchAddress`**
  (country/governate/regionCity/street/buildingNumber — `branches.address` is one free-text line and cannot
  fill it; **same gap ZATCA PRD-003 found, schema change likely**); the fee line configs; the payment-method
  mapping; and the discount `description`. `receiptNumber` is a caller-supplied parameter — Task 5 passes
  `orders.orderNumber` and must settle branch-vs-device uniqueness (ETA scopes it per branch per submission,
  while the uuid chain is per device).
- **Sale-path enqueue failures are row-less; the Task 5 reconciliation sweep is the detection surface.**
- **The sweep does NOT back-submit pre-activation history (decision, 2026-08-31).** It reaches back at most 7 days
  (`RECONCILE_HORIZON_MS`). Older EG orders carry a `dateTimeIssued` months in the past, which is outside the 24-hour
  window and belongs to the formal Late Submission Request path this pipeline does not implement — submitting them on a
  cron tick is not a decision to make by accident. Activating a tenant with genuinely recent history still back-submits,
  up to that bound; anything older is an explicit human call.
- **Task 6 added `zod` as a declared runtime dependency, and BUMPED it 4.4.3 → 4.5.4.** Disclosed here because
  the PR diff makes it look like a pure dev→prod hoist and it is not. `zod` was already in `node_modules` as a
  **dev-only transitive** of `eslint-plugin-react-hooks` (via `zod-validation-error`), so importing it from
  `src/server/fiscal/config-service.ts` would have been a live production hazard — an app-code runtime
  dependency on an eslint plugin's dependency tree. Declaring it (`^4.5.4`) is the fix, but `npm install`
  resolved the caret to a **newer minor than the transitive 4.4.3 that was on disk**, so the lockfile carries a
  version bump as well as a dev→prod flag change. Nothing else in the repo imports zod (house convention is
  hand-rolled validators), so the blast radius is `config-service.ts` alone — but see that file's import
  comment for the one type-level edge that crosses a module boundary.
- **ONLINE ORDERS FISCALISE VIA THE SWEEP, WITH LATENCY, AND CARRY NO QR ON THE CONFIRMATION PAGE.** Stated
  here because the pipeline's shape makes it easy to assume otherwise. The POS path finalises inline —
  `recordSale` calls `enqueueAndFinalizeReceipt` after commit, so the printed customer copy carries the uuid
  and QR at issuance (C5). **There is no equivalent hook on the web/WhatsApp checkout path.** Paid online
  orders are picked up by `reconcileMissingReceipts`, which is therefore not merely the detection surface for
  row-less failures but their PRIMARY enqueue path: an order waits `RECONCILE_AFTER_MS` to become eligible and
  then for the next 15-minute cron tick, so it is enqueued roughly **5-20 minutes after payment**. That is
  comfortably inside ETA's 24-hour window, so it is not a compliance breach — but the customer's online order
  confirmation renders before any of it exists and therefore shows **no uuid and no QR**. Whether the web
  channel owes the buyer a visible fiscal receipt is the same C5 question already settled for the till, asked
  of a channel where the answer was never decided: a **storefront fiscal surface is a named follow-up**
  (VERIFY-10-adjacent), not an oversight, and it is a product decision rather than a pipeline change — the
  document itself is issued correctly either way.
