import type { EtaDocType, EtaEnvironment, EtaCodeSource, ProductTaxCode } from "./schema";
import type { Order, OrderItem } from "@/server/ordering/schema";
import type { Refund, RefundLine } from "@/server/pos/refund-schema";
import type { OrderPayment } from "@/server/pos/tender-schema";

/** One tax-type breakdown row — used both as a document-level total
 *  (`FiscalDocument.taxTotals`) and as a per-line breakdown
 *  (`FiscalDocLine.taxes`). */
export type FiscalTaxAmount = {
  taxType: string;
  taxSubType: string | null;
  rate: string;
  amount: string;
};

/** One line of a fiscal document, mapped from an order/refund line plus its
 *  resolved `product_tax_codes` row. */
export type FiscalDocLine = {
  /** GS1 or EGS item code (`product_tax_codes.itemCode`). */
  itemCode: string;
  /** Our own reference for the item, mapped to receipt v1.2's Mandatory
   *  `internalCode` ("can be used to simplify references back to existing
   *  solution"). The product's id for a sale line; the configured code for a
   *  fee line. Required, because the wire slot is Mandatory and there is no
   *  honest fallback. */
  internalCode: string;
  codeSource: EtaCodeSource; // "gs1" | "egs"
  taxType: string;
  taxSubType: string | null;
  unitType: string;
  description: string;
  quantity: number;
  /** `money(n)` numeric string, mapped verbatim — never recomputed. */
  unitPrice: string;
  discountAmount: string;
  taxes: FiscalTaxAmount[];
  lineTotal: string;
  /**
   * Invoice v1.0's `valueDifference` — "Value difference when selling goods
   * already taxed (accepts +/- numbers), e.g., factory value based." Optional
   * there, absent from every document ServeOS emits today, and carried here for
   * ONE reason: it is a term of Main Calculations rule 42, so the assertion that
   * proves a line's tax is derivable has to be able to read it. Omit it and the
   * assertion is only true for documents that happen not to carry one — see
   * `assertLineTaxesDerivable` in `./eta-wire`, which defaults it to zero.
   */
  valueDifference?: string;
};

/**
 * A structured postal address, exactly the fields ETA's Address type defines.
 *
 * Shared by the receipt's `seller.branchAddress` (see `WireBranchAddress` in
 * `./eta-wire`, which this mirrors field for field) and invoice v1.0's
 * `issuer.address` / `receiver.address`. The first five are Mandatory in every
 * one of those positions; the rest are Optional and are omitted when absent
 * rather than emitted empty (`canonicalSerialize` refuses null outright).
 */
export type FiscalAddress = {
  /** "Country represented by ISO-3166-2 2 symbol code of the countries. Must be
   *  EG for internal business issuers." */
  country: string;
  governate: string;
  regionCity: string;
  street: string;
  buildingNumber: string;
  postalCode?: string;
  floor?: string;
  room?: string;
  landmark?: string;
  additionalInformation?: string;
};

/**
 * `address` is B2B-only and carried for invoice v1.0's `receiver`. The page
 * leaves that field's Cardinality cell BLANK and gives the rule only in prose —
 * "Optional if person buyer and invoice amount less than threshold limit
 * defined" — which we read contrapositively as required for a type-B receiver;
 * see `FiscalInvoiceBuyer`. Receipt v1.2 has no buyer-address slot at all, so
 * `toWireReceipt` ignores it.
 */
export type FiscalBuyer = { type: "B" | "P" | "F"; id?: string; name?: string; address?: FiscalAddress };

/**
 * The fiscal document shape a `FiscalProvider` builds and submits. The four
 * uuid-shaped fields each encode a different part of ETA's identity/chaining/
 * resubmission model — see their individual comments.
 */
export type FiscalDocument = {
  docType: EtaDocType; // "e_receipt" | "e_invoice" | "credit_note" | "return_receipt"
  /** e-receipts/returns: client-computed SHA-256 (Task 3 computes it);
   *  e_invoice: null (ETA assigns it). */
  uuid: string | null;
  /** Per-device chain link: empty string for a device's first receipt; null
   *  for non-receipt docTypes. */
  previousUuid: string | null;
  /** return_receipt/credit_note: the ORIGINAL document's uuid. */
  referenceUuid: string | null;
  /** Corrected resubmission of a rejected doc: the rejected doc's uuid. */
  referenceOldUuid: string | null;
  buyer: FiscalBuyer | null;
  lines: FiscalDocLine[];
  /**
   * Semantic money slots mapped verbatim from the order's stored figures
   * (orders.subtotal, discountAmount, vatAmount, serviceChargeAmount,
   * deliveryFee, vatRateSnapshot — F9, never recomputed here).
   * `EtaFiscalProvider` maps these to receipt v1.2's wire names at
   * submit-build time; this contract itself stays wire-agnostic.
   */
  subtotal: string;
  discountTotal: string;
  /** Service charge + delivery fee etc. */
  feesTotal: string;
  taxTotals: FiscalTaxAmount[];
  /** `money(n)` string, mapped verbatim from the sale/refund. */
  total: string;
  /** ETA Payment Methods code (C/V/CC/VC/VO/PR/GC/P/O), derived from the
   *  sale's tenders. Receipt v1.2 carries ONE `paymentMethod` per document,
   *  so a split payment resolves to its largest tender. Added by Task 3a. */
  paymentMethodCode: string;
  currency: string;
  /** ISO-8601 UTC. */
  issuedAt: string;
};

/**
 * The sale + its resolved `ProductTaxCode[]` + chain inputs needed to build
 * an e-receipt `FiscalDocument`. Task 3 may ADD fields here as the builder's
 * needs emerge — `order`/`items` are already the real row types.
 */
/**
 * The fiscal classification of a fee that ETA has no receipt-level slot for
 * (service charge, delivery) and which therefore ships as its own receipt
 * line. Mirrors `ProductTaxCode`, but for a charge with no product row.
 */
export type FeeLineConfig = {
  itemCode: string;
  codeSource: EtaCodeSource;
  taxType: string;
  taxSubType: string | null;
  unitType: string;
  description: string;
  internalCode: string;
};

export type FiscalSaleInput = {
  order: Order;
  items: OrderItem[];
  taxCodes: ProductTaxCode[];
  /** The sale's tenders, for the `paymentMethod` code. */
  payments: OrderPayment[];
  /**
   * Fiscal classification for the fee lines. Required only for the fees the
   * order actually carries — a non-zero fee with no config here is a
   * `FeeLineConfigMissingError`, never a silently dropped charge.
   *
   * NOTE: `delivery.taxType`/`taxSubType` are currently INERT. ServeOS's
   * `computeOrderTotals` adds the delivery fee AFTER VAT, so the builder
   * hard-codes the delivery line as non-taxable and emits no `taxableItems`
   * for it whatever this config says. Configuring a taxable delivery fee
   * would need the ordering layer to put it in the taxable base first.
   */
  feeLines?: { serviceCharge?: FeeLineConfig; delivery?: FeeLineConfig };
  previousUuid: string;
  deviceSerial: string | null;
};

/**
 * The refund + its resolved `ProductTaxCode[]` + chain inputs needed to
 * build a return-receipt `FiscalDocument` (B2C refund; B2B credit_note is
 * deferred). Task 3 may ADD fields here as the builder's needs emerge —
 * `refund`/`lines` are already the real row types.
 */
export type FiscalRefundInput = {
  parentUuid: string;
  refund: Refund;
  lines: RefundLine[];
  /** The PARENT order's items. `refund_lines` carry only an orderItemId,
   *  quantity and amount, so the description/unit price/productId a document
   *  line needs (and the productId the tax-code lookup keys on) come from
   *  here. Added by Task 3, as this type's contract anticipated. */
  items: OrderItem[];
  /**
   * The PARENT order. Read for ONE field — `vatRateSnapshot`, the rate the sale
   * declared its VAT at — which the return receipt must echo on every
   * `taxableItems` entry it emits, and which is the only way to state a tax
   * amount ETA's per-line equation will accept (Main Calculations rule 42).
   * `refunds`/`refund_lines` store an amount and no rate, so the rate can only
   * come from the sale being reversed. Added by round 2 Task 2.
   */
  order: Order;
  taxCodes: ProductTaxCode[];
  /**
   * Fiscal classification for the SERVICE CHARGE, needed when a refund returns
   * more money than its `refund_lines` name — the order-level charge has no
   * `order_items` row and therefore no `refund_lines` row either, so it ships
   * as its own return line exactly as it ships as its own sale line. Only
   * `serviceCharge` is consulted: the delivery fee is outside ServeOS's taxable
   * base and outside `refund_lines` alike, so it is never separated out here.
   */
  feeLines?: { serviceCharge?: FeeLineConfig };
  previousUuid: string;
  deviceSerial: string | null;
};

/**
 * The BUSINESS BUYER of a B2B e-invoice — invoice v1.0's `receiver`.
 *
 * EVERY FIELD HERE IS AN INPUT, not something derived from the order, and that
 * is the whole point of the type. `orders` stores a `customerName` and a
 * `customerPhone` and nothing else about the buyer: no registration number, no
 * structured address, not even a free-text one for a POS sale.
 *
 * MANDATORY-FOR-B IS OUR READING, NOT A LABEL ETA APPLIED. Invoice v1.0 leaves
 * the Cardinality cell BLANK for `receiver.id`, `receiver.name` and
 * `receiver.address`; the only rule it states is prose, "Optional if person
 * buyer and invoice amount less than threshold limit defined". Read
 * contrapositively that makes all three required for the type-`B` receiver a
 * B2B invoice exists to name — the conservative reading, and the one
 * implemented, because a rejected invoice costs more than an over-strict form
 * field. (Inside `address`, the five fields on `FiscalAddress` ARE labelled
 * Mandatory in their own right; that part is the page's own word.) None of them
 * can be filled from ServeOS data, so they are captured at the trigger instead.
 *
 * VALIDATION IS NOT HERE. Round 2's Task 4 owns the zod schema at the capture
 * boundary (a 9-digit RIN, a non-empty name, the five address components) and
 * runs it ONCE with the operator in front of it — the same division
 * `requireWireContext` documents for the seller half. This builder consumes the
 * value verbatim and refuses only what it could not emit at all.
 */
export type FiscalInvoiceBuyer = {
  /**
   * `receiver.id` — "Registration number. For business in Egypt must be
   * registration number." Named `rin` here because that is ETA's own name for
   * the same value on the seller side (`EtaConfig.rin`), and the two must be
   * the same KIND of identifier for the document to be well formed.
   */
  rin: string;
  /** `receiver.name` — "Registration name of the company or name and surname of
   *  the person." */
  name: string;
  /** `receiver.address` — Mandatory for a type-B receiver. */
  address: FiscalAddress;
};

/**
 * The sale + its resolved `ProductTaxCode[]` + the business buyer needed to
 * build a B2B `e_invoice` `FiscalDocument`.
 *
 * ITS OWN INPUT TYPE, as `FiscalProvider`'s composition block requires: the
 * third builder brings its own rather than widening `FiscalSaleInput`. The
 * overlap with that type is real and deliberate (an invoice IS a sale, priced
 * by the same stored figures and split by the same allocator — `buildSaleLines`
 * in `./build-document` is literally shared), but the differences are
 * structural, not cosmetic:
 *
 *   - NO `previousUuid`. Invoices do not chain; `previousUUID` is a receipt
 *     concept and invoice v1.0 has no slot for it.
 *   - NO `deviceSerial`. An invoice is submitted under the ERP credential, not
 *     a POS device's, and carries no device identity on the wire.
 *   - A MANDATORY `buyer`. A receipt's buyer is an optional walk-in; an
 *     invoice's receiver is the counterparty the document exists to name.
 */
export type FiscalInvoiceInput = {
  order: Order;
  items: OrderItem[];
  taxCodes: ProductTaxCode[];
  /** The sale's tenders. Invoice v1.0 has no `paymentMethod` slot (its
   *  `payment` structure is bank details), so this feeds `paymentMethodCode` on
   *  the contract only — see `toWireInvoice`, which does not emit it. */
  payments: OrderPayment[];
  /** Same contract as `FiscalSaleInput.feeLines`, including the INERT delivery
   *  tax classification: ServeOS adds the delivery fee after VAT, so its line
   *  carries no `taxableItems` whatever this says. */
  feeLines?: { serviceCharge?: FeeLineConfig; delivery?: FeeLineConfig };
  buyer: FiscalInvoiceBuyer;
};

/**
 * A `FiscalDocument` that has been mapped to its ETA wire JSON, hashed into
 * its uuid and given its QR url — i.e. everything `submit` needs and nothing
 * it does not.
 *
 * `submit` takes THIS rather than a `FiscalDocument` because the uuid is the
 * SHA-256 of the exact bytes transmitted: re-deriving the wire document inside
 * the provider would risk it diverging from the document that was hashed. The
 * uuid and qrUrl are also what the caller persists on `eta_submissions`
 * whether or not the HTTP call succeeds.
 */
export type FinalizedFiscalDocument = {
  docType: EtaDocType;
  /** The receipt v1.2 / invoice v1.0 JSON, property order preserved — see
   *  `stringifyWire`. */
  wire: Record<string, unknown>;
  /**
   * 64-hex, self-computed; the document's fiscal identity — for the RECEIPT
   * family only.
   *
   * NULL for `e_invoice`, and that is the model rather than a gap: ETA assigns
   * an invoice's uuid in its submission response, so there is nothing to compute
   * and nothing to match a response entry on. The invoice path matches on
   * `internalId` instead ("Internal document ID used to link back to the ERP
   * document number") — see `toWireInvoice` and `EtaFiscalProvider.submit`.
   */
  uuid: string | null;
  /**
   * The portal url the printed receipt's QR encodes.
   *
   * NULL for `e_invoice`. The QR url is built FROM the self-computed uuid
   * (`buildQrUrl`), which an invoice does not have at issuance; ETA publishes no
   * invoice QR template at all, and the B2B read surfaces show the ETA-assigned
   * `longId` as text instead. `qr_payload` therefore stays null on an
   * `eta_submissions` row for an invoice, for its whole life.
   */
  qrUrl: string | null;
};

/**
 * Mapping to `eta_submission_status` for a RETURNED result:
 *   "accepted"  terminal pass — only ever from `poll`.
 *   "rejected"  terminal refusal; `responseJson` carries ETA's errors.
 *   "submitted" 202 accepted-for-processing; the verdict arrives via `poll`.
 *   "skipped"   no submission row is written at all (non-EG tenants).
 *
 * A THROWN error is not one of these — see the FAILURE TAXONOMY on
 * `FiscalProvider` below for which of the three families it is and what the
 * worker must do with each.
 */
export type FiscalSubmitResult = {
  status: "accepted" | "rejected" | "submitted" | "skipped";
  etaUuid?: string;
  etaLongId?: string;
  submissionUuid?: string;
  qrPayload?: string;
  hashOrSignature?: string;
  responseJson: Record<string, unknown>;
};

export type EtaDeviceCredentials = {
  serial: string;
  clientId: string;
  secret1: string;
  secret2: string;
  presharedKey: string | null;
  osVersion: string | null;
  modelFramework: string | null;
};

/**
 * Resolved ETA credentials for a `submit()`/`poll()` call — secrets in
 * memory only, never persisted. `erp` is the ERP-level credential (B2B
 * e_invoice + codes APIs); `device` is the per-device credential used for
 * e-receipt submission (null until a device is registered).
 */
export type EtaConfig = {
  /** Taxpayer Registration Identification Number — ETA's own name for it, and
   *  the same value as `WireContext.rin`. The DB column stays
   *  `eta_tenant_config.registration_number`; Task 3b's `resolveEtaConfig`
   *  maps the two. */
  rin: string;
  environment: EtaEnvironment; // "preprod" | "prod"
  /**
   * The ERP-level credential. `clientSecret` is a THUNK, not a string: it is
   * read by exactly one code path (the ERP login, used only when `device` is
   * null — B2B `e_invoice` and the codes APIs), so resolving it eagerly let a
   * stale ERP secret ref take the receipt path down with it. Calling it
   * resolves the secret and may throw `EtaConfigError`; see
   * `resolveEtaConfig` for the full rationale.
   */
  erp: { clientId: string; clientSecret: () => string };
  device: EtaDeviceCredentials | null;
  /**
   * e-seal signing material — B2B only, and unused for receipts today (ETA has
   * not deployed receipt batch-signature validation; addendum C7).
   *
   * A THUNK for exactly the reason `erp.clientSecret` is one, and it matters
   * more here: nothing on the receipt path reads this, so resolving it eagerly
   * meant a tenant whose `signing_key_ref` had gone stale could not submit
   * RECEIPTS either — `resolveEtaConfig` threw for the whole tenant, and the
   * worker turned that into a PERMANENT failure on every receipt, over a
   * credential no receipt uses. Deferring keeps the failure at the signer that
   * needs it.
   *
   * Returns `null` when the tenant has no signing material at all (the normal
   * receipt-only case); THROWS `EtaConfigError` naming the column and env key
   * when a ref is set but unresolvable.
   */
  signingKey: () => string | null;
};

/**
 * `buildCreditNote` (B2B e_invoice corrections) is deliberately absent —
 * deferred with the B2B trigger; adding it later is a breaking change to
 * every implementer, accepted cost.
 *
 * COMPOSITION — the worker (Task 5) drives these in order:
 *
 *   1. `buildReceipt` / `buildReturnReceipt`  -> FiscalDocument   (pure)
 *   2. `finalizeReceipt(doc, wireCtx, opts)`  -> FinalizedFiscalDocument (pure)
 *   3. `submit(finalized, cfg)`               -> FiscalSubmitResult (HTTP)
 *   4. `poll(submissionUuid, cfg)`            -> terminal accept/reject
 *
 * Steps 1-2 are pure and live in `./build-document` + `./eta-wire`; only 3-4
 * touch the network. The `WireContext` step 2 needs is resolved by the worker
 * per tenant/branch/device (RIN, trade name, branch code + address, activity
 * code, device serial), with `receiptNumber` resolved per document. STEP 1's
 * OWN inputs are likewise resolved per document, not per tenant — the rows the
 * document is built from PLUS the tenant configuration that document needs
 * (tax codes, fee-line classifications, the parent order behind a refund): see
 * `FiscalSaleInput` / `FiscalRefundInput`, and `./finalize`'s
 * `buildSaleDocument` / `buildReturnDocument` for the assembly. A third builder
 * (B2B `e_invoice`) takes the same shape — its own `Fiscal*Input`, assembled
 * there, rather than widening either of these. Round 2 Task 3 built exactly
 * that: `FiscalInvoiceInput` above, assembled by `./finalize`'s
 * `buildInvoiceDocument`, with steps 1-2 running `buildInvoice`
 * (./build-invoice) + `toWireInvoice` (./eta-invoice-wire) and NO hash step at
 * all — an invoice's uuid is ETA's to assign, so there is nothing to compute and
 * no QR to derive from it (see `FinalizedFiscalDocument.uuid`). The money
 * pipeline underneath is NOT re-derived: `buildInvoice` calls the same
 * `buildSaleLines` the e-receipt does.
 *
 * FAILURE TAXONOMY — the complete contract for what a thrown error means and
 * what Task 5's worker must do about it. Three families, three behaviours;
 * this table is the single place they are written down, because a worker that
 * gets this wrong either retries something that can never succeed or gives up
 * on something that would have.
 *
 *   FiscalDocumentError  (`./errors`)
 *     PERMANENT — a document-construction failure: these inputs cannot produce
 *     a valid ETA document, so retrying is pointless. Worker: `status =
 *     "failed"`, `lastError = message`, NO backoff, NO further attempts.
 *     Owner-facing alert to fix data (a missing tax code, an unconfigured fee
 *     line). Never blocks the sale — the money is taken and the receipt printed
 *     before any of this runs.
 *
 *   EtaConfigError       (`./eta-transport-errors`)
 *     PERMANENT — a CONFIGURATION failure: an unresolvable secret ref, a device
 *     missing its pre-shared key, or ETA refusing the credentials outright.
 *     The document is fine; the account is not. Worker: same no-retry handling
 *     as above (`"failed"`, no backoff), but the alert is owner-ACTIONABLE
 *     ("finish ETA setup"), not a data fix — so the two must stay
 *     distinguishable rather than being collapsed into one branch.
 *
 *   EtaTransportError    (`./eta-transport-errors`)
 *     RETRYABLE — the call did not land: throttled, gateway error, network
 *     failure, or a malformed body where a documented shape was promised.
 *     Worker: `attempts++` and back off, honouring `retryAfterSeconds` as a
 *     FLOOR when ETA sent one, up to the attempt cap.
 *
 * Discriminate with `instanceof` on the three classes, and switch on `code`
 * for alert copy. All three expose a `code`; `EtaTransportError` additionally
 * carries `etaErrorCode`, which is ETA's own code (`BadStructure`, `429`, ...)
 * rather than ours.
 */
export interface FiscalProvider {
  readonly name: string; // "eta" | "noop"
  /** Pure: builds an e-receipt FiscalDocument, no I/O. */
  buildReceipt(input: FiscalSaleInput): FiscalDocument;
  /** Pure: builds a return-receipt FiscalDocument, no I/O. */
  buildReturnReceipt(input: FiscalRefundInput): FiscalDocument;
  /** Pure: builds a B2B e-invoice FiscalDocument, no I/O. */
  buildInvoice(input: FiscalInvoiceInput): FiscalDocument;
  /** submit()/poll(): one document per submission — batching is out of
   *  contract; a batch submission model would require poll to return
   *  per-document results (`FiscalSubmitResult[]`). */
  submit(finalized: FinalizedFiscalDocument, cfg: EtaConfig): Promise<FiscalSubmitResult>;
  /**
   * Polls a prior "submitted" result for its terminal accept/reject — see the
   * one-document-per-submission note on submit().
   *
   * `docType` is REQUIRED and is not inferable from the submission uuid: the
   * receipt family and the B2B family are polled through two different ETA APIs
   * (`/api/v1/receiptsubmissions/{uuid}/details` vs
   * `/api/v1.0/documentsubmissions/{uuid}`) whose response shapes and status
   * vocabularies both differ. `submit` reads the same discriminator off
   * `FinalizedFiscalDocument.docType`; a poll has no document in hand, so the
   * caller supplies it rather than the provider defaulting to a family and
   * being quietly wrong for the other.
   */
  poll(submissionUuid: string, cfg: EtaConfig, docType: EtaDocType): Promise<FiscalSubmitResult>;
  /**
   * Looks a RECEIPT-FAMILY document up by its self-computed uuid — `null` when
   * ETA does not hold it (HTTP 404).
   *
   * WHY IT EXISTS: a submit can reach ETA without us learning so (a timeout
   * after the request was sent, a 202 with no `submissionUUID`). Re-POSTing such
   * a document is idempotent only inside ETA's ~10-minute payload dedupe, and
   * the worker's next attempt is usually later than that — so before re-POSTing
   * a row that MAY have been sent, the worker asks ETA whether it already has
   * it. Receipts only: their uuid is ours and deterministic; an invoice's is
   * ETA's and does not exist until ETA answers.
   *
   * OPTIONAL: a provider without it (the no-op provider, simple test fakes)
   * simply makes the worker skip the lookup.
   */
  lookupReceipt?(uuid: string, cfg: EtaConfig): Promise<FiscalSubmitResult | null>;
}
