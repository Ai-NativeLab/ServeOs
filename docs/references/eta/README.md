# ETA e-invoicing & e-receipts — primary source documents

Official Egyptian Tax Authority documents underpinning **Spec 11** (`docs/ailab/specs/2026-07-24-eta-einvoicing-and-ereceipts-design.md` + the **2026-08-30 verified-findings addendum** beside it), captured **2026-08-30**.

Kept in-repo deliberately (same rationale as `docs/references/zatca/`): ETA republishes at the same URLs, so "the version we designed against" is not otherwise recoverable.

| File | What it is | Used for |
|---|---|---|
| `ereceipt-registration-guide.pdf` | دليل الممول للاستعداد لمنظومة الإيصال الإلكتروني — الجزء الأول: التسجيل (ETA taxpayer registration guide, 46 pp, Arabic) | The two registration routes (tax office vs e-seal self-registration), the **dual preprod+prod invitations**, ERP registration issuing Client ID + Secret 1/2, per-POS device registration (accredited model + serial), B2B/B2C tagging |
| `einv-selfreg.pdf` | E-invoicing self-registration steps (ETA, English) | The e-seal-signed online self-registration flow (ITIDA Web Sign Client, Windows-only) |
| `regulations.md` | **The full regulatory research** (verified 2026-08-30): legal framework, wave catalog, enforcement economics, registration & e-seal boundary, sandbox verdict, accreditation program, and the OFFICIAL / SECONDARY / COULD-NOT-VERIFY evidence lists | The compliance reference behind Spec 11; the debunked 250k-threshold claim's durable refutation |

Source URLs (fetched 2026-08-30):

```
https://pos.eta.gov.eg/sites/default/files/2022-04/دليل%20التسجيل%20بمنظومة%20الإيصال%20الإلكتروني.pdf
https://eta.gov.eg/sites/default/files/2022-12/E-INVOICING-SELF-REGISTRATION.pdf
```

Key live references (not captured — fetch fresh when needed):

- SDK (fully public, no login): https://sdk.invoicing.eta.gov.eg/ · preprod mirror https://sdk.preprod.invoicing.eta.gov.eg/
- Receipt schema v1.2, UUID/serialization, QR, 24h window: `/documents/receipt-v1-2/`, `/receiptissuancefaq/`, `/document-serialization-approach/`
- POS auth (posserial/presharedkey headers, B2C tag): `/ereceiptapi/01-authenticate-pos/`
- Offline validation toolkit (zero-credential golden tests): `/toolkit/home/`
- Wave decisions index: https://www.eta.gov.eg/ar/content/qrarat-alalzam-bmnzwmt-alfatwrt-alalktrwnyt · RIN obligation inquiry: https://www.eta.gov.eg/ar/ereceipt-inquiry
- ITIDA licensed e-seal providers: https://itida.gov.eg/English/Pages/E-Signature.aspx

⚠️ Engineering research from public documents. Requires review by a qualified Egyptian tax adviser before any commercial commitment. The "EGP 250k threshold / 31 Mar 2026" claim circulating in vendor blogs is **contradicted by official sources** — do not reintroduce it.
