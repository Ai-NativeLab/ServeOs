# Egypt e-Invoicing & e-Receipts — Regulatory Research (verified 2026-08-30)

**What this is.** The full regulatory research behind Spec 11, captured from two research passes run
2026-08-30/31 under a hard-facts-only standard: every load-bearing claim was verified against **official
pages fetched live that day** — eta.gov.eg, sdk.invoicing.eta.gov.eg, pos.eta.gov.eg, itida.gov.eg,
portal.eta.gov.eg — with verbatim quotes. Consultancy/vendor sources could *corroborate* but never
*establish* a fact. Tags: **[O]** = official (ETA/ITIDA page, PDF, or reproduced law text, quoted verbatim);
**[S]** = secondary only (reputable but no official text retrieved). §9 carries the three evidence lists.

**What this is not.** Engineering research from public documents. It **requires review by a qualified
Egyptian tax adviser before any commercial commitment** (same standing warning as ZATCA PRD-003).
The build-authority document is the [verified-findings addendum](../../ailab/specs/2026-08-30-eta-verified-findings-addendum.md);
where the two disagree on what the *code* does, the addendum wins. Captured primary PDFs: see [README](README.md).

---

## 1. Legal framework [O]

- **Law 206/2020 (Unified Tax Procedures)** — the statutory basis:
  - **Art. 35**: sellers designated by the executive regulations must record all sales/purchases on ETA's
    electronic system — «يجب على الشركات وغيرها من الأشخاص الاعتبارية والطبيعية... تسجيل جميع مشترياتهم
    ومبيعاتهم من السلع والخدمات على النظام الإلكتروني» ("companies and other juridical and natural persons …
    must record all their purchases and sales of goods and services on the electronic system").
  - **Art. 37**: every taxpayer must issue a tax invoice/receipt, and «يجب أن يتم إصدار الفاتورة أو
    الإيصال... في شكل محرر إلكتروني» ("the invoice or receipt must be issued as an electronic document").
  - **Art. 38**: books, records and documents **including invoice copies** kept **5 years** after the tax
    period — «يلتزم الممول أو المكلف بالاحتفاظ بالسجلات والدفاتر والمستندات بما فيها صور الفواتير لمدة خمس
    سنوات تالية للفترة الضريبية».
  - **Art. 71**: fine **EGP 20,000–100,000** for violating (inter alia) Arts. 35, 37, 38 — «يُعاقب بغرامة
    لا تقل عن عشرين ألف جنيه ولا تجاوز مائة ألف جنيه...». Covers failing to issue e-invoices AND e-receipts.
  - (Full-text host used for the article text: https://qadaya.net/?p=12464 — legal reproduction of the official text.)
- **Minister of Finance Decree 188/2020** (26 Mar 2020) launched the e-invoice mandate: registrants must
  issue electronic tax invoices bearing the issuer's **e-signature** and the ETA-approved **unified
  goods/service code** — «يلتزم المسجلون بإصدار فواتير ضريبية إلكترونية تتضمن التوقيع الإلكتروني لمصدرها
  والكود الموحد للسلعة أو الخدمة» (quoted in ETA's own Phase 1&2 taxpayer deck:
  https://www.eta.gov.eg/sites/default/files/2021-09/E-Invoice%20Taxpayers%20presentation-Phase%201%20&%202.pdf).
- **Minister of Finance Decree 286/2021** — executive regulations; its Art. 34 imposes the
  electronic-document obligation (e-invoice / professional e-receipt / consumer-sales e-receipt).
- **VAT Law 67/2016** is the substantive VAT law the documents serve; the deduction linkage (§3) was
  implemented via regulation amendments (reported vehicle: Minister Decision 188/2023 **[S]** for the
  decree number; the rule itself is official, §3).
- **E-Signature Law 15/2004** governs the e-seal; **ITIDA** is the licensing regulator (§4).

## 2. The two systems, and who is mandated (as of Aug 2026)

Egypt runs **two separate clearance systems** under one SDK umbrella, and ETA states explicitly that their
obligation stages are **unrelated** [O:
https://www.eta.gov.eg/ar/news/mrahl-alzam-almmwlyn-walmklfyn-bmnzwmt-alaysal-alalktrwny-lys-lha-laqt-bmrahl-alzam-almmwlyn]:

| | e-Invoice (فاتورة, B2B/B2G) | e-Receipt (إيصال, B2C/POS) |
|---|---|---|
| Who is mandated | **Everyone.** Phased decisions 386/2020 (134 cos), 518/2020 (347), 85/2021, 195/2021, 443/2021, 619/2021, 208/2022, then **323/2022 "Phase 8": all companies at all tax offices nationwide** [O: index https://www.eta.gov.eg/ar/content/qrarat-alalzam-bmnzwmt-alfatwrt-alalktrwnyt]. Professionals (doctors, engineers, lawyers…) registration deadline **15 Dec 2022** [O]; grace to 30 Apr 2023 [S]. ETA FAQ: «جميع ممولي مصلحة الضرائب المصرية ملزمين بالانضمام إلى المنظومة» ("ALL ETA taxpayers are obligated to join") [O: https://eta.gov.eg/ar/node/1381] | **Named taxpayers in cumulative wave annexes** — NOT yet all B2C merchants. Verified waves: **289/2022** (153 companies, 1 Jul 2022; pilot 15 Apr 2022), **345/2022** (400, 1 Oct 2022), **186/2024** (15 Jul 2024), **278/279/280 of 2024** (1 Dec / 1 Oct / 1 Nov 2024), **455/2024** (15 Jan 2025), **225/2025** (15 Jul 2025), **281/2025** (15 Sep 2025), **361/2025** (15 Nov 2025 — latest verified) [O: per-decision pages on eta.gov.eg]. **No 2026 wave decision found** (absence, not proof). Obligation check per RIN: https://www.eta.gov.eg/ar/ereceipt-inquiry [O] |
| Clearance model | Pre-issuance validation; **ETA assigns UUID + longId** [O: SDK] | Post-clearance; **client computes the UUID**, submits within **24h** [O: SDK] |

- **VAT registration threshold: still EGP 500,000** per ETA's FAQ [O: https://eta.gov.eg/ar/node/1379].
- **⚠️ Debunked claim (do not reintroduce):** vendor blogs (orchidatax, datavalue, invoicedataextraction)
  circulated "threshold cut to **EGP 250,000**, register by **31 Mar 2026**". Official sources contradict it:
  Decision **281/2025 is an ordinary e-receipt wave decision with no threshold content** [O], and the FAQ
  still states 500k [O]. This claim briefly lived in our own Spec 11 draft and was removed 2026-08-30.
  Related number confusions found in trackers: Pagero's "Resolution 405/2024" (ETA's page says **455/2024**);
  KPMG's "Decision 123/2025" (no official page found).
- Each wave decision also requires registering on the consumer-incentive portal «فاتورتك – حمايتك وجايزتك»
  ("Your invoice — your protection and your prize") [O].

## 3. Enforcement economics — why merchants adopt ahead of their wave [O]

- **VAT deduction/refund only against e-invoices since 1 Apr 2023** — «عدم خصم أو رد الضريبة إلا للفواتير
  الإلكترونية فقط اعتبارًا من الأول من أبريل ٢٠٢٣»
  [O: https://www.eta.gov.eg/ar/news/dm-khsm-aw-rd-aldrybt-ala-llfwatyr-alalktrwnyt-fqt-atbarana-mn-alawl-mn-abryl-2023].
- **Cost/expense recognition only via e-invoices since 1 Jul 2023**; same page: no import/export or Nafeza
  customs dealings without e-invoicing
  [O: https://www.eta.gov.eg/ar/news/atbarana-mn-1-ywlyw-2023-ln-ytm-alatdad-ala-balfwatyr-alalktrwnyt-fy-athbat-altkalyf].
  (Regulatory vehicle reported as Minister Decision 188/2023 [S].)
- **Government payment orders**: from 1 Dec 2022 state administrative bodies may not issue electronic payment
  orders to suppliers without system-issued invoices — Ministerial Decree **595/2022**
  [O: https://www.eta.gov.eg/ar/news/mnzwmt-alfatwrt-alalktrwnyt-26]. Earlier Cabinet contracting ban from
  1 Oct 2021 [S].
- **E-receipts pulled into the same logic**: ETA head (12 Oct 2025): e-invoices between taxpayers and
  e-receipts with final consumers are «الركيزة الأساسية لضمان خصم ورد الضريبة» ("the fundamental pillar for
  ensuring tax deduction and refund")
  [O: https://eta.gov.eg/ar/news/alfatwrt-alalktrwnyt-walaysal-alalktrwny-shrt-asasy-lathbat-altkalyf-wrd-drybt-alqymt-almdaft].
  A dated hard cutover for e-receipts equivalent to the invoice rules was **not found**.
- **2025 package** (Gazette 12 Feb 2025) [S — KPMG/TaxSPOC/Lexology-corroborated]: **Law 5/2025** (amnesty —
  unregistered taxpayers registering within 3 months not pursued for prior periods; e-invoice/e-receipt
  adoption part of the deal); **Law 6/2025** (simplified regime, turnover ≤ **EGP 20m**, 0.4%–1.5% of
  revenue); **Law 7/2025** (caps late-payment penalties at 100% of original tax).
- **Decree 420/2025** operationalizes Law 6/2025 — beneficiaries must keep «فاتورة إلكترونية أو إيصال
  إلكتروني بحسب الأحوال» ("an electronic invoice or electronic receipt, as applicable")
  [O: https://www.eta.gov.eg/ar/news/qrar-wzyr-almalyt-rqm-420-lsnt-2025]; ETA head (8 Mar 2026): benefiting
  **requires active enrollment in BOTH platforms** [O statement via press:
  https://www.dailynewsegypt.com/2026/03/08/e-invoice-e-receipt-compliance-required-to-benefit-from-simplified-tax-system-eta-head/].
- **June 2026 VAT amendments** (parliament, 23 Jun 2026): sectoral rate changes, faster refunds — **no
  threshold change, no new e-invoicing scope change found** [S: Daily News Egypt, SIS].

## 4. Registration, credentials, and the e-seal

### 4.1 Taxpayer registration — two documented routes [O]

Source: ETA's own registration guide (captured in this folder as `ereceipt-registration-guide.pdf`, 46 pp) and
`einv-selfreg.pdf`.

- **Route A — tax office (المأمورية):** signed request from the company's official email → officer review →
  «تقوم المأمورية بإخطار الممول بموعد للحضور وتقديم أصول المستندات» (**physical appointment presenting
  original documents**): national ID/passport of the representative, tax card and/or VAT registration
  certificate, a company authorization letter (bank-certified if neither taxpayer nor proxy attends) →
  e-transactions directorate creates the digital profile → **TWO invitations are emailed**: «يتم ارسال دعوتين
  للممول: أحدهما للعمل على البيئة الاختبارية (التجريبية) والثانية للعمل على البيئة الفعلية» — one for
  **preprod**, one for **production** (guide p. 15, in red).
- **Route B — online self-registration (التسجيل الذاتي):** «شروطه: 1- وجود الختم الالكتروني … 2- استخدام
  ويندوز 10» — requires (1) **an e-seal certificate**, (2) Windows 10 (ITIDA Web Sign Client). The e-invoice
  steps PDF: *"Any Taxpayer will use this feature must have a digital signature with E-Seal certificate that
  has the Tax registration ID."* Sign-up URLs: profile.preprod.eta.gov.eg / profile.eta.gov.eg.
- Registration types: **mandatory** (named in an ETA-head decision) vs **voluntary** (any company may join
  early) [O, guide p. 11]. The taxpayer's e-receipt subscription is tagged **B2B, B2C, or both** (p. 23).
- Lead time: **not stated on any official page**. "3–5 working days to invitation" is vendor-quoted [S:
  datavalue, ilora].

### 4.2 The e-seal — and the trade-registry boundary [O: ITIDA]

Source: https://itida.gov.eg/English/Pages/E-Signature.aspx (regulator under E-Signature Law 15/2004).

- **Four licensed providers**: El Delta Electronic Systems (15715), Fixed Misr (15966), **MCDR** — Misr for
  Central Clearing, Depository and Registry (16774), **Egypt Trust** (19877).
- Issuance requires: contract signed by the **legal representative per the commercial registry**, at the
  licensee's premises (bank-certified delegation letter + company seal for a delegate); *"a copy of a valid
  national ID card or a valid passport of the legal representative … There is no alternative to this
  document"*; **commercial registry ≤ 3 months old** + valid tax credentials.
- **Hard boundary, verbatim**: *"the law does not permit the issuance of an electronic seal for a sole
  proprietorship with no commercial registry, establishment decision, or declaration, but has a tax card."*
  → **no trade registry ⇒ no e-seal ⇒ no online self-registration route.**
- Costs [S — vendor-quoted, not official]: ~EGP 2,000/3,000/4,000 for 1/2/3 years + ~EGP 500 USB token
  (Pioneers/FEDIS reseller); market range ~1,500–4,000 incl. token (edariba). Lead time "24–48 business
  hours" is vendor talk [S]. Form factor: USB-token flows officially; *"provided … only as a hardware token
  device that can't be added to an Azure key vault"* [S: Microsoft Dynamics docs]; HSM-for-volume is
  integrator practice [S: EDICOM, SAP].
- **When it is actually needed**: B2B e-invoice v1.0 signing (CAdES-BES) and Route-B self-registration.
  **Not for B2C e-receipt submission today** — receipt batch-signature validation *"will not be deployed at
  this point until a decision is provided by ETA"* [O: SDK]; e-invoice **v0.9** exists with *"signature
  validation is disabled"* [O: SDK] (whether v0.9 remains enabled per-taxpayer: could-not-verify).

### 4.3 Integration credentials [O: guide + SDK]

- **Per ERP system**: taxpayer profile → register ERP → portal displays **Client ID + Client Secret 1 +
  Client Secret 2 once** («لا يمكننا عرضها لك مرة أخرى» — "we cannot show them to you again").
- **Per POS device**: profile/POS registration (branch, **accredited device model**, name, **serial**,
  activation dates) → **separate Client ID + Secret 1/2 per device**, with expiry. Token calls additionally
  require headers **`posserial`, `pososversion`, `posmodelframework`, `presharedkey`**; token TTL 3600 s;
  *"Only Taxpayers assigned with B2C tag will be allowed to submit receipts."* [O: SDK authenticate-pos]
  Where the portal displays the presharedkey value: **not publicly documented** (could-not-verify).
- Device rules: *"The POS device issuing the receipt has to have been registered and linked to the issuer RIN
  before the receipt is issued"*; retired devices auto-reject [O: SDK receipt FAQ].

## 5. The sandbox boundary — building with zero registration [O]

- **The SDK is fully public, no login**: https://sdk.invoicing.eta.gov.eg/ and the preprod mirror
  https://sdk.preprod.invoicing.eta.gov.eg/ — schemas for every document version, the canonical-serialization
  algorithm **with a published worked example (input + expected output)**, UUID/QR rules, validation
  equations (/main-calculations/), code tables, Postman collections, rate-limit rules, and a runnable
  **offline toolkit** (Docker/NuGet/CLI: uuid, qrcode, issue-receipt, local validators) usable with zero
  credentials. Environment URL table: /faq/ [O]. Preprod TLS chains to an **internally-issued Root CA** [O].
- **The first hard wall is `POST {id}/connect/token`** — the first network call of any end-to-end test.
  Credentials exist only inside a (preprod) **taxpayer digital profile**, and both documented ways to obtain
  one require a real Egyptian tax registration (§4.1); Route B additionally requires the e-seal, which
  requires the commercial registry (§4.2).
- **No public developer signup, demo taxpayer, or test RIN exists** — confirmed as *absence of any official
  documentation* as of 2026-08-30, not as a positive statement by ETA. The sanctioned outsider routes are the
  POS-supplier accreditation program (§6) or piggybacking on a registered pilot merchant (the login API
  supports an `onbehalfof` intermediary header [O]).
- **Verdict (as exercised by this repo):** ~90% of an integration is buildable and unit-testable
  unregistered — Spec 11 shipped with ETA's published example as a byte-exact CI golden vector — but
  end-to-end testing, preprod validation of VERIFY-9/10, and any live submission are registration-gated.

## 6. POS supplier accreditation [O: pos.eta.gov.eg]

- ETA runs a formal approval program for **companies supplying POS devices** "معتمدة طبقًا للمعايير
  والمتكاملة مع منظومة الإيصال الإلكتروني": ~10 steps — formal request, document review + site visit, **NDA**,
  ETA provides functional specs + certification test cases, device/app handover, testing, accreditation
  certificate valid **24 months** [O: https://pos.eta.gov.eg/ar/عملية-اعتماد-موردي-نقاط-البيع]. Six firms
  initially approved (Delta Electronic Systems, Alice, Abis, Arab Consulting Group IT, Egypt Computer,
  Egyptian Engineering Office) [O: portal.eta.gov.eg news]; the approved list + a device serial-check tool
  are published [O].
- This is a **vendor-side track available without being a taxpayer-merchant** — and the sanctioned way a POS
  maker obtains ETA test cases under NDA.
- **Open (could-not-verify):** whether buying from approved suppliers is *compulsory* — the official framing
  is facilitation («تيسيرًا على الممولين»), the merchant registration UI picks from an accredited-model
  list, and **no instrument was found either way**. How a software POS on generic hardware registers its
  serial is to be resolved during the first pilot registration. Note: ETA has warned that for the free
  portal channel no middleman software is approved except via **E-Tax Co.** («إيتاكس») [O]; direct API
  integration under the taxpayer's own credentials is the sanctioned default.

## 7. Technical requirements in brief (what the code implements)

Kept short — the [addendum](../../ailab/specs/2026-08-30-eta-verified-findings-addendum.md) §§3/6 is the
build authority and the SDK is the wire authority. Headlines, all [O]:

- **e-Receipt**: JSON, Receipt v1.2 (+ Return Receipt v1.2, `receiptType "r"`, mandatory `referenceUUID`,
  **positive amounts**, ≤ **540 days**); client-computed **UUID = SHA-256 of the canonical serialization**,
  chained per device via `previousUUID`; submit within **24h** (late → formal Late Submission Request);
  async 202 + `submissionUUID`, poll for `Valid|Invalid`; corrections via `referenceOldUUID` (new UUID);
  QR = `{portal}/receipts/search/{UUID}/share/{dateUTC}#Total:{t},IssuerRIN:{rin}`; items coded **GS1 or
  EGS** (EGS codes need ETA approval via the codes API); buyer types B/P/F with the **EGP 150,000** P-type
  ID threshold (v1.2); `feesAmount`/`adjustment` *"accept only zero values"*; validation equations published
  at /main-calculations/ with ±0.5 tolerances.
- **e-Invoice (deferred B2B)**: v1.0 requires **CAdES-BES e-seal** signature; ETA assigns UUID + longId;
  credit/debit notes reference originals; cancellation window is an ETA-configurable parameter.
- **Open items**: VERIFY-9 (uuid blanking: keep-key-empty vs drop — one line in `computeReceiptUuid`,
  confirm on preprod) and VERIFY-10 (offline/unsynced sales print without a QR — compliance stance is an
  ETA/tax-adviser question; ETA's own offline toolkit implies locally-issued receipts are the sanctioned
  offline model). See the addendum §5 ledger.

## 8. ZATCA parallels (Saudi — PRD-003)

Same `FiscalProvider` abstraction, different regime. Shared findings worth knowing exist in both:
the **structured seller/branch address gap** (free-text `branches.address` satisfies neither regime —
ServeOS fills ETA's via `wireContextJson`), the **offline-issuance question** (ZATCA Q3 ↔ VERIFY-10), and
per-sequence/per-device **document chaining** (ZATCA ICV/PIH ↔ ETA previousUUID). See
[docs/prds/prd-high-zatca-einvoicing.md](../../prds/prd-high-zatca-einvoicing.md).

## 9. Evidence classification (merged from both research passes)

### OFFICIAL-VERIFIED (fetched + quoted 2026-08-30)
Law 206/2020 Arts. 35/37/38/71 · Decrees 188/2020, 286/2021, 595/2022, 420/2025 · e-invoice obligation
decisions 386/518 (2020), 85/195/443/619 (2021), 208/323 (2022) · professionals' 15 Dec 2022 deadline ·
"all taxpayers obligated" FAQ (node/1381) · EGP 500k threshold FAQ (node/1379) · e-receipt waves 289/345
(2022), 186/278/279/280/455 (2024), 225/281/361 (2025) with dates · deduction rules (1 Apr 2023 VAT,
1 Jul 2023 costs, customs) · registration guide (both routes, dual invitations, document list) ·
self-registration e-seal prerequisite · ITIDA's four licensed CSPs + issuance requirements + sole-proprietor
exclusion · per-ERP and per-POS credential issuance · POS token headers + B2C tag gate · SDK technicals
(serialization + worked example, UUID/chain/QR, receipt v1.2 + return receipt, 24h window + late submission,
main-calculations equations, v0.9 vs v1.0 signing, unenforced receipt signatures, codes APIs, rate limits,
environment table, preprod Root CA, offline toolkit) · POS supplier accreditation program · RIN inquiry tool.

### SECONDARY-ONLY (no official text retrieved)
Laws 5/6/7 of 2025 contents + Gazette date (KPMG/TaxSPOC/Lexology/M1) · Decision 188/2023 as the
deduction-rule vehicle · same-day e-invoice submission since Jan 2023 (Fonoa) · 281/2025 targeting Sixth
District/Fifth Settlement offices (KPMG) · 30 Apr 2023 professionals' grace · Cabinet's 1 Oct 2021
contracting ban · e-seal prices/lead-times (Pioneers/FEDIS, edariba) · registration lead time 3–5 days
(datavalue, ilora) · hardware-token-only claim (Microsoft) · HSM-for-volume practice (EDICOM/SAP) ·
June 2026 VAT amendment details (press).

### COULD-NOT-VERIFY (relied on by nothing; absence is the finding)
The "EGP 250k / 31 Mar 2026" threshold claim — **contradicted** by official sources · KPMG's "Decision
123/2025" · Pagero's "Resolution 405/2024" (ETA says 455/2024) · any 2026 e-receipt wave · a dated hard
rule making e-receipts the exclusive proof of B2C costs · whether accredited POS hardware is compulsory ·
where the portal displays the presharedkey value · whether invoice v0.9 remains enabled for new taxpayers ·
any public developer sandbox / demo taxpayer · official e-seal price lists · whether/when ETA will enforce
receipt batch signatures ("until a decision is provided by ETA") · official registration-lead-time SLA.
