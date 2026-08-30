# ETA Spec 11 — Verified-Findings Addendum (2026-08-30)

**Status:** Authoritative delta over `2026-07-24-eta-einvoicing-and-ereceipts-design.md` and its plan.
Where this addendum and the original spec/plan disagree, **this addendum wins.**

Every claim below was verified 2026-08-30 against official pages — eta.gov.eg, sdk.invoicing.eta.gov.eg,
pos.eta.gov.eg, itida.gov.eg — with verbatim quotes captured in the research session. Primary-source PDFs are
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
- **QR:** the C5 format string, rendered at issuance.
- **Returns:** Return Receipt referencing the original UUID, ≤ **540 days**.
- **Environments:** APIs `api[.preprod].invoicing.eta.gov.eg`; **preprod TLS chains to ETA's internally-issued
  Root CA** — the submit client must trust it (config/env, never `NODE_TLS_REJECT_UNAUTHORIZED=0`).
- **Rate limits:** per-ERP/POS selective throttling; 429 + `Retry-After`; `X-Rate-Limit-*` headers.
- **Retention:** Law 206/2020 Art. 38 — keep documents (incl. invoice copies) **5 years**; `requestJson`/`responseJson` satisfy this.

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
