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
  **IT IS AN E-RECEIPT RULE, and round 2 Task 8 checked rather than assumed** (2026-09-01, fetch-first). The 24
  hours and the whole Late Submission apparatus appear on exactly ONE SDK page — the **Receipt Issuance FAQ**
  (`/receiptissuancefaq/`) — in receipt nouns: *"The receipt is allowed to be submitted within the allowed
  duration (24 hours), unless this receipt is being resubmitted and has the OLD UUID added to the receipt/return
  receipt"*, with *"Late Submission Window (Days) - Sets the maximum age of documents that will be accepted by a
  Late Submission Request"*, *"Late Submission Period (Hours) - …"* and *"Late Submission Request will consume
  from users current yearly quota…"*. Those two parameters are configuration ON the LSR path (how stale a
  document an LSR may rescue), not a second ordinary deadline. **No invoice page states any submission
  deadline:** `/documents/invoice-v1-0/` constrains only the field (*"Date and time cannot be in future. Time to
  be supplied in UTC timezone."*), `/einvoicingapi/01-submit-documents/` rejects on BadStructure /
  MaximumSizeExceeded / IncorrectSubmitter / Forbidden / DuplicateSubmission with nothing temporal, and
  `/integrationpractices/` and `/faq/` carry none. So the late machinery is **receipt-scoped** —
  `isReceiptSubmissionWindowFamily` (`fiscal/constants.ts`) covers `e_receipt` + `return_receipt` — and an
  `e_invoice` is never flagged. Open as **VERIFY-13** below.
  **`return_receipt`'s inclusion is an INFERENCE, not a quotation, and the distinction is recorded rather than
  smoothed over.** The rule's subject is singular — *"**The receipt** is allowed to be submitted…"* — and the
  string "receipt/return receipt" appears only in the trailing exception clause, so the sentence does not name
  the return receipt as bound. Three signals put it inside: (1) the carve-out *presupposes* it — an exemption
  written for return receipts only means something if return receipts are subject to the rule it exempts them
  from; (2) the page treats "receipt/return receipt" as one **base structure** throughout, matching the SDK's own
  `receipt-v1-2` / `return-receipt-v1-2` split of a single family; (3) the wording is **generic normative** — "The
  receipt" is the family's generic noun in a rule statement, not a discriminator drawn against returns, which the
  page never draws. The risk is pointed the safe way: if the inference is wrong, a return receipt past 24h draws
  a false alarm on ServeOS's own dashboard with no effect on what is filed or when; excluding returns and being
  wrong would silently miss a real breach.
  **24 hours is a CURRENT VALUE, not a spec constant.** The FAQ presents it as *"the allowed duration (24
  hours)"* — the reading of a submission workflow parameter ETA configures on its side, in the same family as the
  Late Submission parameters above. ETA can reconfigure it, and if it does, `SUBMISSION_WINDOW_MS` is wrong
  everywhere with no error anywhere: submissions keep working and the dashboard simply flags against the old
  duration. One constant with two readers for exactly that reason; first thing to re-read on preprod.
- **Late state (round 2 Task 8):** past the window the worker **still submits** and additionally tells the owner
  **once** — `eta_submissions.late_notified_at`, set by a compare-and-set on `IS NULL` with the notify gated on
  that UPDATE having affected a row (the `failPermanently` precedent; an expired claim lease can put two drains
  on one row). Flagging consumes no `attempts` and runs outside the row's try/catch, so a notification failure
  can never become a submission failure. `late` is DISTINCT from `overdue` and both are kept: `overdue` is the
  live clock condition and goes false on acceptance; `late` is the historical fact and does not, because an LSR
  is owed for a document that WAS late whether or not ETA eventually took it. The clock origin is `created_at`,
  which for a sweep-adopted online order trails `dateTimeIssued` by up to the 7-day sweep horizon — a
  backlog-adopted row therefore reads on-time for its first window; bounded, stated at the derivation, pinned by
  a test.
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
| 10 Offline issuance without QR | **OPEN** — an EG offline/unsynced sale prints with no QR (the chain is computed server-side at sync); the reprint carries it once synced. Whether handing the customer a QR-less copy at sale time is compliant is an ETA/tax-adviser question (ETA's own offline toolkit implies local issuance is the sanctioned model); mirrors ZATCA PRD-003 Q3. Raised by Task 7 (POS receipt footer). **Widened by round 2 Task 5:** an unsynced B2B sale prints no fiscal line at all, not merely a missing QR — a business buyer's copy says nothing about the tax invoice being filed for them (the invoice itself is filed correctly on sync; see §6). Same question, one channel wider. |
| 11 issuerSerial GeneralName tag | **OPEN** — ETA's published signed sample (`/files/one-doc-I.json`) wraps the `signingCertificateV2` issuerSerial DN in `[0]` (0xa0, the `otherName` alternative) while RFC 5280 spells `directoryName` `[4]`; both measured off real bytes, not inferred. ServeOS emits the RFC-correct `[4]`, because copying a known-wrong tag assumes ETA's VALIDATOR shares its ENCODER's bug — which the sample cannot tell us. Signature validation is undeployed, so nothing judges it today. **One line in `sign-invoice.ts`** (`type: 4` → `0` in `signingCertificateV2`), pinned as bytes by `sign-invoice.test.ts` so a flip is deliberate. **Test BOTH forms against preprod before any tenant configures a real seal.** Raised by round 2 Task 3 spec review. See §6. |

| 12 Receipt→invoice conversion | **OPEN** — whether/how ETA supports issuing a B2B invoice for a sale already filed as an e-receipt (cancel + reissue? a reference mechanism from the invoice back to the superseded receipt? nothing at all?). ServeOS's research has never covered it, so there is no filing shape to implement against. **Until it is answered, ServeOS refuses cross-family issuance:** `config-service.requestB2bInvoice` 409s any order carrying a non-rejected `e_receipt`, because two accepted documents for one sale is that sale declared twice in the taxpayer's filings. The refusal blocks a real and ordinary workflow — a customer asking for a tax invoice after their receipt was filed — and the sanctioned workaround is to capture the buyer at the till so the sale is filed as an invoice from the start — **shipped in round 2 Task 5** (the payment screen's "Business buyer (فاتورة ضريبية)" section), so the workaround is now available rather than merely named, and the refusal only bites on a sale nobody flagged as B2B at the counter. ONE exception is permitted and is not a bypass: an order whose every `e_receipt` row is REJECTED with no correction queued has no ETA document at all, so refusing would leave it permanently undeclared. Raised by round 2 Task 4 quality review. |
| 13 Invoice submission deadline | **OPEN** — whether ETA imposes ANY submission window on an e-invoice, as it does the 24 hours on an e-receipt. **None found on the SDK pages** — checked page by page on 2026-09-01: `/documents/invoice-v1-0/` (only *"Date and time cannot be in future. Time to be supplied in UTC timezone."*), `/einvoicingapi/01-submit-documents/` (rejection codes only — BadStructure, MaximumSizeExceeded, IncorrectSubmitter, Forbidden, DuplicateSubmission), `/integrationpractices/`, `/faq/`. The 24-hour rule and the Late Submission apparatus live solely on the **Receipt Issuance FAQ** and are spelled in receipt nouns ("…the receipt/return receipt"). **Absence of documentation is not absence of a rule**: the portal's Late Submission parameters are worded document-agnostically, and a deadline could sit in the taxpayer portal or in the law rather than in the SDK. **And the silence of `01-submit-documents` is weaker evidence than it looks, which is the specific reason this is a gate rather than a finding:** that page scopes itself to the SYNCHRONOUS structural checks a submission call answers with — it returns 202 and its five codes (BadStructure, MaximumSizeExceeded, IncorrectSubmitter, Forbidden, DuplicateSubmission) are envelope-level, while business-rule validation happens ASYNCHRONOUSLY afterwards and its rejection reasons are nowhere enumerated on that page. A lateness rule would surface as an async business rejection, i.e. exactly in the space the page does not document. Its silence is CONSISTENT WITH there being no invoice deadline; it does not establish one. **Until answered, the late machinery is RECEIPT-SCOPED** (`isReceiptSubmissionWindowFamily`): an invoice is never flagged and the dashboard renders `not-applicable` rather than `on-time`, so nothing asserts an invoice beat a deadline nobody has shown us. Confirm on preprod or with a tax adviser. **The fix, if a deadline exists, is small and pre-shaped:** one more constant plus a docType branch in `isReceiptSubmissionWindowFamily` — the read model already carries the third state to move an invoice out of, and `read-model.test.ts` pins that the read must not start reporting `late` before that predicate is updated to agree. Raised by round 2 Task 8's pre-check. |

## Deployment constraints

Not VERIFY items — nothing to ask ETA. These are things a ServeOS deployment must not do, discovered while building the fiscal layer, and they belong in the ops runbook rather than in code.

- **Two ServeOS tenants must never be configured with the same ETA registration number.** An invoice's `internalID` is its `orders.orderNumber`, which ETA uses as the match key for both `acceptedDocuments` and `rejectedDocuments` (an invoice has no uuid at submission). `orderNumber` uniqueness is PER TENANT — `placeOrder` allocates MAX+1 under a per-tenant advisory lock — while ETA scopes document identity PER RIN. Two tenants sharing one registration number would therefore each allocate from their own sequence and could file two live invoices under one taxpayer with one `internalID`, cross-mapping ETA's assigned uuid/longId onto the wrong document. ServeOS cannot assert this away: every query the trigger runs is inside `withTenant`, and RLS is precisely what stops it from seeing the other tenant's rows. If a deployment ever needs two tenants on one RIN, `internalID` must gain a tenant-discriminating prefix first. (Recorded at `config-service.requestB2bInvoice`'s JSDoc and `enqueue.ts`'s `internalID` marker.)

## Operational constraints

Not VERIFY items and not deployment rules — these are things anyone RUNNING this code (CI included) must know, discovered by measurement rather than by reading.

- **The fiscal suites MUST run serially against the single shared test database, and ONE vitest process at a time.** Not a preference and not flake-tolerance. Two mechanisms, both real:
  - **Cross-tenant worker interference.** `drainEtaSubmissions` iterates **every EG tenant** it can see, so two fiscal test files running concurrently have each one's worker claiming, submitting and finalizing the other's freshly seeded rows. This is correct in production (one worker, one fleet, every tenant) and only becomes a hazard when the "fleet" is several test processes pointed at one database. **Measured:** 8-way parallel → **3 failures in 2620s**; serial → **green in 79s**. Serial is not merely more reliable, it is ~33× FASTER — contention on the one Postgres is the dominant cost.
  - **`truncateAll` between files.** `src/db/test-setup.ts` truncates every table in a `beforeEach`, so a SECOND vitest invocation wipes the first's fixtures mid-test. `vitest.config.ts` already sets `fileParallelism: false`, which handles this WITHIN one run — the live hazard is therefore not the config but the habit of starting a focused suite (`npx vitest run src/server/fiscal`) while the full `npm test` is still going. **Observed on this branch, first-hand:** doing exactly that produced one failure inside `test-setup.ts`'s own `beforeEach` (not in any assertion) and stretched the full run from 244s to 708s; both suites passed when re-run alone.

  Both present as a small number of unreproducible failures scattered across unrelated assertions, which is the shape a reader dismisses as flake and reruns. The note exists so that a future "let's parallelise CI" change is made with the mechanism in hand rather than rediscovered through a week of intermittent red — and so a failure inside `beforeEach` is read as "something else was touching the database" rather than as a broken test.

  **A PARAGRAPH IS NOT ENOUGH, and that is measured too:** the second mechanism above was tripped TWICE in the single session that discovered and documented it, both times by reflexively starting a focused suite to check one thing while the full run was still going. It is an easy habit and knowing about it does not prevent it. The durable fix is mechanical rather than editorial — a lock file the test setup refuses to start without, or a per-process database — and until one exists this constraint will keep being violated by people who have read this note.

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
- **~~No VAT is reversed on returns — LIVE FISCAL EXPOSURE~~ — RESOLVED 2026-08-31 (round 2, Tasks 1 + 2).**
  *The exposure as found:* `refunds` stored only `totalAmount` and `refund_lines` only `quantity` + `amount`
  (zero `vat`/`tax` columns in `src/server/pos/refund-schema.ts`), so return receipts declared
  `netAmount == totalAmount` with no `taxableItems` and **a tenant issuing returns over-declared output VAT** —
  the sale's VAT was reported in full and none was credited back.
  *The mechanism now:* round 2 Task 1 persists `refunds.vatAmount` + `refund_lines.vatAmount`, computed ONCE at
  issuance from the order's own stored figures (`src/server/pos/refund-vat.ts` — largest-remainder over the
  same `computeOrderTotals` basis, service charge in its own bucket, floored at zero per line). Task 2 maps
  those stored figures onto the wire: `buildReturnReceipt` emits per-line `taxableItems` and a document
  `taxTotals`, `netSale` is the line's money less the tax it carries (or the money itself when the order was
  priced VAT-exclusive and the tax rides on top — `vatMode`, the same fork the sale builder uses), and
  `assertTotalsReconcile` now enforces Main Calculations **rule 42**
  (`taxableItems[T1].amount = netSale * rate / 100`, within ETA's published `± 0.5`) on every line of every
  document, sales included, plus an explicit refusal of non-positive line taxes.
  *The de-top decision, and why it was needed:* `refund-vat.ts` stage [4] tops an itemised FULL refund's line
  VATs up with the service charge's share, because that share has no product line of its own. Emitted verbatim
  that breaks rule 42 — 13.51 on a 100.00 line reports `netSale` 86.49, which the rule prices at 12.11, 1.40
  out against a 0.5 tolerance, i.e. rejected. So the top-up is **un-done at the wire**: each product line is
  capped at the tax its own money contains, and the money the refund returned that no `refund_lines` row names
  (`refunds.totalAmount − Σ line amounts` — the service charge) becomes its OWN return line carrying the
  remainder, using the tenant's `feeLines.serviceCharge` classification and failing with the existing
  `FeeLineConfigMissingError` when there is none. Same fees-as-item-lines decision as the sale side (§6 above).
  The header is still reversed in full and to the cent: 12.28 + 1.23 = the stored 13.51.
  *Headerless refunds* (the commonest shape — no `refund_lines` at all) carry their VAT on the header alone;
  `finalize.ts` `resolveFullRefundLines` splits it largest-remainder across the lines it resolves from the
  parent order, over the same amounts.
  *Zero and legacy:* `vatAmount` of `0.00` or the legacy `'0'` emits no `taxableItems` and no `taxTotals`
  (round 1's omission rule — a zero amount at a non-zero rate fails rule 42).
  *One honest residual, carried forward:* the POS refund screen builds a line from `order_items.lineTotal`
  (`apps/pos/src/screens/SalesHistory.tsx`) and requires a PARTIAL refund's tender to equal it, so a
  VAT-exclusive tenant refunding one 100.00 item pays back 100.00 while the refund domain attributes that
  item's whole 14.00 of VAT. 100.00 of money contains 12.28, so the document reports 12.28 and `taxTotals`
  follows the lines (which is ETA's own definition of it). Under-reversing is the safe side; reporting 14.00
  would claim credit for tax the customer never got back and be rejected outright. Closing the gap properly
  means the POS offering the GROSS line amount on a partial refund — a POS-layer change, not a mapper one.
- **B2B e-invoice engine SHIPPED, submitting UNSIGNED v0.9 — two VERIFY-gated caveats (round 2, Task 3).**
  `build-invoice.ts` + `eta-invoice-wire.ts` map a sale plus a captured business buyer to **invoice v1.0**
  (`documentType` `"I"`, `issuer`/`receiver` rather than `seller`/`buyer`, `invoiceLines` rather than
  `itemData`, `salesTotal`/`netTotal`/`unitValue.amountEGP` rather than `totalSale`/`netSale`/`unitPrice`),
  submitted as `{"documents":[…]}` to `POST /api/v1.0/documentsubmissions/` under the **ERP** credential and
  polled at `GET /api/v1.0/documentsubmissions/{uuid}`. The money is not re-derived: `buildInvoice` calls the
  **same `buildSaleLines`** the e-receipt does, so an invoice and a receipt for one sale can never disagree
  about that sale's output VAT. **ETA assigns the identity** — `eta_uuid` is null until the 202 answers,
  matching is on `internalID` (`orders.orderNumber`), and there is **no QR at all** (no invoice QR template
  exists), so `qr_payload` stays null for the document's whole life and the read surfaces show `longId` as
  text. Key ORDER is asserted section-by-section against ETA's own published invoice
  (`__fixtures__/one-doc.json`, the same file the serialization golden vector already proves byte-for-byte).
  **CAVEAT 1 — signing is IMPLEMENTED but REGISTRATION-GATED; it was BLOCKED on node:crypto and was
  unblocked by a declared dependency.** *The gap as found:* ETA's container (published parsed at
  `/files/parsed-cades-bes.txt`) is DER CMS `SignedData` — detached, `eContentType` `digestedData`, signed
  attributes `contentType`/`signingTime`/`messageDigest`/**`signingCertificateV2`** (ESSCertIDv2 carrying the
  cert's SHA-256 and its issuerSerial) — and `node:crypto` has **no ASN.1/DER encoder** and **no X.509
  certificate generation** (`X509Certificate` parses only; its statics list is empty, verified), so neither
  the container nor a self-issued test certificate was obtainable. *The resolution (coordinator decision,
  same reviewable-dependency treatment as `zod` in round 1):* **`pkijs` 3.4.0** + **`asn1js` 3.0.10** +
  **`pvutils` 1.2.0** added as declared runtime dependencies (one transitive, `bytestreamjs` 2.0.1; all pure
  JS, no native build; lockfile +73 lines). `pkijs` was chosen as the only SINGLE addition covering both
  halves — `node-forge` builds PKCS#7 authenticated attributes but has **no `signingCertificateV2`**, the
  attribute that makes a container CAdES-BES rather than plain CMS, and generates no certificate either; the
  `@peculiar/asn1-*`+`x509` set needs four packages. **The PR body must carry the dependency line.**
  *What is mirrored field-for-field off ETA's dump*, including the three choices a generic CMS recipe gets
  wrong: `eContentType` is **`digestedData`**, not `id-data`; the SignerInfo's `signatureAlgorithm` is
  **`rsaEncryption`**, not `sha256WithRSAEncryption`, and carries no NULL params (deliberate on ETA's part —
  the certificate's own signature field in the same dump *does* use `sha256WithRSAEncryption` WITH a NULL);
  and ESSCertIDv2 has **two** elements, its `hashAlgorithm` absent under RFC 5035's DEFAULT sha256, so
  emitting it explicitly would be a different encoding from the one ETA published. Two silent-failure traps
  are recorded in code: the signature is computed over `DER(SET OF Attribute)` (RFC 5652 §5.4), which is *not*
  the transmitted `[0]` form — the first byte is retagged `0xa0`→`0x31`, and getting it wrong yields a
  container that parses perfectly and verifies against nothing; and `crypto.sign(null, DigestInfo, key)` does
  **not** produce a verifiable sha256 signature on Node 22 (measured), while
  `privateEncrypt(DigestInfo, RSA_PKCS1_PADDING)` does and is byte-identical to `sign("sha256", message, key)`
  — which is what keeps the `InvoiceSigner` seam at the DIGEST, the surface a real PKCS#11 token exposes.
  *Still registration-gated, and this is the caveat:* `TestCertSigner`'s certificate is **issued by nobody**.
  ETA accepts only "approved eSeal or natural person signature certificates in Egypt" from an ITIDA-licensed
  CA (Egypt Trust in ETA's own sample), held on hardware ServeOS never sees. The 28-case suite re-parses our
  own output and verifies the signature **against the certificate that made it** — self-verification, which
  proves the bytes are internally consistent and proves nothing about ETA accepting them. No signed document
  has been put in front of preprod, because that needs a registered taxpayer profile.
  *And the go-live path is not the shipped one:* `PemBundleSigner` (the non-null branch of
  `resolveInvoiceSigner`) reads a PEM blob holding a PKCS#8 key **and** a certificate, which a soft
  certificate can provide and a hardware e-seal cannot — an ITIDA token's private key is non-exportable, so
  production needs a PKCS#11 implementation behind the same interface. Material that is present but unusable
  throws the same permanent `invoice-signing-unavailable`, so an unusable seal can never silently downgrade a
  sealed tenant to unsigned v0.9.
  **CAVEAT 2 — v0.9 availability is unverified, and it is what ships today.** The version flip is live —
  a tenant whose `signing_key_ref` resolves to usable material gets `documentTypeVersion` `"1.0"` with the
  CAdES-BES `signatures` element, decided at FINALIZATION rather than at submit time because the version is
  part of the document's own signed bytes. But **no tenant has an e-seal**, so every invoice in practice ships
  as `"0.9"`, on ETA's own sentence: *"v0.9 of the Invoice document type structure is maintained as v1.0, the
  only difference is that signature validation is disabled on this version."* That is the **entire** published
  guidance; nothing states whether v0.9 is still accepted in production, and the documents index carries no
  deprecation column. It is one preprod submission away from being settled and cannot be settled by reading.
  **The mandatory receiver fields Task 4's zod must own** (none derivable from ServeOS data — `orders` stores
  a `customerName` and a `customerPhone` and nothing else about a buyer): `id` (9-digit registration number),
  `name`, and `address.{country, governate, regionCity, street, buildingNumber}`. **"Mandatory for type `B`"
  is OUR reading, not ETA's label, and the distinction is worth keeping:** the invoice v1.0 page leaves the
  Cardinality cell **blank** for `receiver.id`/`name`/`address` and states the rule only in prose — "Optional
  if person buyer and invoice amount less than threshold limit defined" — which read contrapositively makes
  all three required for the type-`B` receiver a B2B invoice exists to name. That is the conservative reading
  and the one implemented, because a rejected invoice costs more than an over-strict form field; if preprod
  proves otherwise the fields become optional, not the reverse. Receiver Address separately DOES label those
  five Mandatory within itself — that word is the page's own. `buildInvoice` refuses an incomplete receiver by
  name (`BuyerIdRequiredError`) rather than filing a misidentified legal document.
  **Two page-vs-sample naming conflicts**, resolved and recorded: `internalID`/`branchID` follow ETA's own
  samples (capital `D`) over the pages' `internalId`/`branchId`, per round 1's rule that working JSON wins on
  spelling; `documentType` is emitted `"I"` following both samples, though the page's prose says "Must be `i`"
  and Get Submission reports `typeName` lower-case — a one-character flip if preprod disagrees.
- **Rule 42 is now checked in FULL, and `taxTotals` groups by (taxType, subType) (round 2, Task 3).** The
  per-line assertion previously checked the equation's REDUCED form on the stated assumption that ServeOS emits
  no T2/T3/T5-T12/`valueDifference` — an assumption its own JSDoc said had to be WIDENED, never bypassed, if any
  of them were introduced. B2B invoices are the document family that can carry them, so
  `assertLineTaxesDerivable` now assembles the whole published base
  (`T2 + netSale + Σ T5-T12 + valueDifference + T3`) from the line itself, with every absent term defaulting to
  zero, and is scoped to `T1` as rule 42's own condition states. **The sale and return paths are provably
  unchanged** — their added terms are all zero — pinned as an explicit zero-case test rather than left to
  inspection, alongside a T5-bearing line the reduced form would have wrongly refused (16.80 on a base of
  120.00, which the old form priced at 14.00 and rejected as 2.80 out). Separately, both builders used to take
  the document's single `taxTotals` entry from the FIRST taxed draft and pair it with the whole stored VAT
  figure — byte-identical for every single-tax-type document (pinned), and simply wrong for a mixed one.
  `aggregateTaxTotals` now folds the LINES' own taxes, which is ETA's own definition (rule 26), grouping by
  (taxType, subType) so two subtypes cannot claim one rate; `foldTaxTotalsByType` sums them back to ETA's
  per-taxType wire shape at emit time, where "TaxType needs to be unique" actually applies.
- **Wire-boundary fail-closed guards.** The mapper refuses rather than emits a document it cannot total
  correctly: `UnsupportedTaxTypeError` for **T4** (ETA's line-total equation SUBTRACTS T4 where every other
  type is added — withholding support is deliberate work, so T1/T2/T3/T5-T20 are allowed and T4 is rejected);
  `BuyerIdRequiredError` for a `B` buyer or a `P` buyer at/above the threshold with no `buyer.id`;
  `EmptyReturnReceiptError` for a header-only full refund (`issueRefund` inserts `refund_lines` only when the
  caller names them, but `itemData` is Mandatory); `DisproportionateRefundLineError` for a return whose line
  amounts are distributed differently from the VAT stored against them (round 2 — thrown by the BUILDER, ahead
  of the wire's own per-line check, so the owner is told the cause and the remedy "reissue as a headerless full
  refund" instead of a failed equation); `NonPositiveLineTaxError` for a zero or negative
  `taxableItems` amount (round 2 — zero is OMITTED per the rule above, negative would be an invented input tax
  credit); and `EtaTotalsMismatchError` for `totalAmount`, `taxTotals<taxType>`,
  `totalSale = quantity * unitPrice` and (round 2) the per-line rule 42
  `taxableItems.amount = netSale * rate / 100`. `unitPrice` is always DERIVED from the line's
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
  document itself is issued correctly either way. **BUILT in round 2 Task 6 — see the next bullet; the latency
  described here is unchanged by it, and is what makes "pending" the state most visitors meet.**
- **THE ONLINE STATUS PAGE NOW SHOWS THE FISCAL DOCUMENT (round 2, Task 6) — the "storefront fiscal surface" the
  bullet above named as a follow-up, now built.** `/order/[token]` renders the e-receipt's QR and ETA uuid, or a tax
  invoice's ETA long id, family-aware off `SaleFiscalStatus.docType`; a non-EG tenant's page is unchanged in bytes and
  in query count. The token is the whole authorisation — no new route and no new permission surface — and the read
  delegates to `getSaleFiscalStatus`, so the storefront cannot re-acquire the receipt-only blindness the read model
  shed in Task 5. **THE LATENCY CAVEAT IN THE PRECEDING BULLET IS UNCHANGED AND STILL GOVERNS WHAT A CUSTOMER SEES:**
  the document is still enqueued by the sweep rather than at checkout, so a page opened straight from payment shows
  "Fiscal receipt pending" — honest, and the state most visitors will meet. The page does not live-update either
  (`StatusPoller` never re-renders the server component, and no realtime event is published when a fiscal row is
  written), so the QR appears on a revisit. The surface that actually delivers it to the customer is the receipt email,
  Task 7.
- **TILL B2B CAPTURE: A SALE IS DECLARED AS ONE FAMILY, DECIDED AT THE COUNTER (round 2, Task 5).** A cashier who
  opens the payment screen's "Business buyer (فاتورة ضريبية)" section and fills in the seven fields ETA requires of
  a type-`B` receiver rings a sale that is filed as an **`e_invoice` INSTEAD of an `e_receipt`** — never as well as
  one. Leaving the section collapsed is an ordinary B2C sale, unchanged in every respect. This is the sanctioned
  answer to **VERIFY-12**: because ETA offers no mechanism ServeOS knows of for converting a filed receipt into a
  tax invoice afterwards, the choice has to be made before the sale is filed, which is why it lives at the till and
  not on the next morning's dashboard. Three things enforce the one-family rule, and all three are needed: the till
  enqueues one document (source), `config-service.requestB2bInvoice`'s cross-family rung refuses a second
  (dashboard), and `reconcileMissingReceipts`' not-exists now treats ANY order-carrying row as satisfying (sweep) —
  before that last one, every B2B sale outliving `RECONCILE_AFTER_MS` would have been adopted into a second document
  deterministically, not as a race.
- **SEVEN FIELDS AT THE COUNTER IS A DELIBERATE COST.** Invoice v1.0 makes the buyer's registration number,
  registered name and five address components (country, governate, region/city, street, building number) Mandatory
  for a type-`B` receiver, and there is no partial form: an invoice missing any of them is not a well-formed
  document. Asking for all seven while the buyer is standing there beats the alternative, which is a permanent
  `EtaConfigError` on a `failed` row hours later. The end state is a **B2B buyer directory** — repeat business
  customers captured once and then chosen by name or registration number — recorded as a future ticket.
- **AN UNSYNCED B2B SALE PRINTS NO FISCAL LINE (limitation, same shape as VERIFY-10).** The buyer rides inside the
  till's own `sale.recorded` event, so a B2B sale rung during an outage is still filed as an invoice when it syncs —
  it can never silently become a consumer receipt, and that is pinned end to end through the real offline store,
  sync engine and route. What it cannot do is print anything at issuance: an unsynced sale has no server order to
  read a fiscal record from, so the customer copy carries the provisional-sync notice and nothing about the tax
  invoice. For a B2C sale this is exactly VERIFY-10's QR-less copy; for a B2B one the buyer is told nothing at all.
  The number appears on a reprint after sync. Fixing it needs the captured buyer carried into the receipt data so
  the footer can say "pending sync" without a server round trip — a named follow-up, not a filing defect.
- **THE ONLINE CUSTOMER'S FISCAL DOCUMENT ARRIVES BY EMAIL, AND THAT IS THE PRIMARY CHANNEL RATHER THAN A CONVENIENCE (round 2, Task 7).**
  *Why it is primary:* an online order is fiscalised by `reconcileMissingReceipts`, so its `eta_submissions` row is
  written **5-20 minutes after payment** — long after the customer closed the status page. Task 6's storefront fiscal
  block does not live-update (`StatusPoller` sets its own state and never calls `router.refresh()`; the worker
  publishes no realtime event when it writes a fiscal row; the poller stops at a terminal order status, which a
  10-minute order reaches *before* the fiscal row exists), so that block is **what a revisit shows** and its own
  rationale defers the reliable copy here. `src/server/fiscal/customer-email.ts` is the only thing that reaches a
  customer who has left.
  *Family-aware, on the same axes `orderFiscalView` splits on:* an `e_receipt` carries ETA's uuid plus the QR's
  **portal link**; an `e_invoice` carries ETA's long id, **no QR ever**, and **links to nothing** — `qr_payload` is
  null for an invoice's whole life (no invoice QR template exists, §6 above) and no URL is invented to stand in for
  one.
  *The inline-QR finding:* it is not satisfiable through this provider surface. `EmailMessage` is exactly
  `{from, replyTo, to, subject, html, idempotencyKey}` — no attachments array, no content-id map — so a CID inline
  image needs a widening of a shared interface plus both implementations. The `data:` URI alternative was refused
  deliberately: Gmail and Outlook strip `data:` image sources, so it renders as a broken-image icon for most
  recipients, which is worse than no image because a quiet failure that looks like a broken tax document is exactly
  what this work exists to prevent. **The portal link IS the QR delivery** — `qr_payload` is a public ETA URL
  (`{portal}/receipts/search/{uuid}/share/{date}#Total:…,IssuerRIN:…`), the identical string the printed QR encodes,
  so scanning and clicking land on the same page.
  *It sends DIRECTLY, diverging from both house patterns:* `notify()` addresses staff only (`{userId}`/`{role}`), and
  the outbox pattern `sendPurchaseOrder` uses — which would buy retries, backoff and an exhaustion alert — was
  rejected because **it makes the outcome asynchronous, and the outcome is the deliverable**. A queued row can only
  stamp "handed off"; the verdict would land in `notification_outbox.last_error`, keyed by nothing the fiscal
  dashboard reads, leaving `customer_email_error` a column nothing could populate. The honest cost is **one attempt,
  no backoff**: a transient blip loses that customer's email permanently, and what replaces the retry ladder is
  visibility. That trade is only acceptable because the **fiscal obligation is already discharged** — ETA holds the
  document and the sale is declared; the customer's copy is a courtesy and must never be confused with compliance.
  Retries later mean an outbox row PLUS a callback that stamps these columns, never a second silent send path.
  *Visible failure is a correctness gate:* `eta_submissions` gains `customer_emailed_at` + `customer_email_error`
  (migration **0053**, family-neutral names) and the dashboard's submissions table gains an "Email" cell with **three**
  states — a time, an amber `failed` marker carrying the redacted reason, or an em-dash for **nobody to email**. The
  third is not a failure and must stay distinguishable from one, or a broken `EMAIL_FROM` looks exactly like a guest
  who declined to give an address. `customer_email_error` follows `last_error`'s stance exactly (owner audience, env
  KEY names acceptable, values never); neither column is selected by `getSaleFiscalStatus`, so the token surface
  cannot reach either, and the rendered **email payload** is walked at the stricter `TOKEN_FORBIDDEN` — a forwarded
  email is the widest audience in the subsystem, wider than `/order/[token]`, with no expiry and no revocation.
  *The hook sits after the acceptance transaction COMMITS*, deliberately the opposite placement to the audit and
  notify calls beside it (which must be atomic with the status write): a throw inside would roll back the status,
  `acceptedAt`, `etaLongId` and the audit event, so a failed courtesy email would have unfiled a fiscal fact.
  Idempotent on `customer_emailed_at`, because an expired claim lease can put two drains through `persistAccepted`
  for one document.
  *THE CAPTURE RULING, and the reality check behind it:* ServeOS captured an email **nowhere** — `orders` had no such
  column, and `customers.email` sits on a table a **guest never has a row in** (`orders.customer_id` is null forever
  for guests, who are the online channel's majority). Sending "only for orders that have an email" would therefore
  have shipped a path firing for approximately nobody. So `orders` gains a **nullable `customer_email`** and checkout
  gains **one optional input**, labelled with its purpose. Recipient resolution is
  `orders.customer_email` → `customers.email` via `customer_id` → **none**, with rung 1 beating rung 2 on purpose (a
  signed-in customer typing a different address for this order is expressing a preference about this document).
  *PURPOSE LIMITATION AT BIRTH:* there is **no marketing-consent flag anywhere in the schema**, so nothing can refuse
  a marketing send except the column's own JSDoc, which names the refusal in as many words — this order's tax
  document and nothing else, and any other use requires a consent flag and a withdrawal path FIRST. Stated because an
  address column with no declared purpose does not stay single-purpose, and the repurposing never looks like a
  decision when it happens.
  *POS SCOPE, recorded rather than worked around:* **the till captures no email at any point in its flow**, so every
  POS sale resolves to "none" and is silently not emailed, by design. Asking a cashier to type a customer's address
  at the counter is the seven-field B2B form's problem again; if till-side delivery is ever wanted, the shape is the
  same directory-and-picker fix that form needs, not a sixth field.

- **THE FISCAL AUDIT VOCABULARY IS FOUR ACTIONS, and the fourth is not a synonym for the third (round 2, Task 10b).**
  `eta.submission.submitted` / `accepted` / `rejected` / **`failed`** (`fiscal/effects.ts`,
  `FISCAL_AUDIT_ACTIONS`). The last was added when the widened audit-coverage scan reached the worker's private
  terminal-failure writers and found them mutating the fiscal record without recording it.
  **`failed` IS NOT `rejected`, AND CONFLATING THEM WOULD MAKE THE AUDIT TRAIL CLAIM SOMETHING THAT NEVER
  HAPPENED.** `rejected` means ETA looked at the document and refused it — a verdict, with a correction path
  (`referenceOldUUID`, C3) and a `responseJson` carrying ETA's own reason. `failed` means ETA never judged it at
  all: the sale's data could not be built into a valid document, the tenant's ETA configuration is incomplete, or
  transport gave out after `MAX_ATTEMPTS`. To a tax adviser asking why a sale is undeclared those are opposite
  answers — one says the taxpayer filed and was refused, the other says nothing was ever filed — and only the
  second leaves the obligation entirely unmet.
  *Emitted ONCE per document*, on the write that makes the failure terminal (`failPermanently` always;
  `failTransiently` only on the attempt that exhausts the cap), gated by the same compare-and-set that decides
  which drain alerts — so two drains holding one row produce one event, and a six-attempt ladder produces one
  event rather than six.
