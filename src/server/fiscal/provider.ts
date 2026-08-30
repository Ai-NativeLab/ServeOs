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
};

export type FiscalBuyer = { type: "B" | "P" | "F"; id?: string; name?: string };

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
  taxCodes: ProductTaxCode[];
  previousUuid: string;
  deviceSerial: string | null;
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
  /** The receipt v1.2 JSON, property order preserved — see `stringifyWire`. */
  wire: Record<string, unknown>;
  /** 64-hex, self-computed; the document's fiscal identity. */
  uuid: string;
  /** The portal url the printed receipt's QR encodes. */
  qrUrl: string;
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
  /** e-seal signing material — B2B only; unused for receipts today. */
  signingKey: string | null;
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
 * code, device serial), with `receiptNumber` resolved per document.
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
  /** submit()/poll(): one document per submission — batching is out of
   *  contract; a batch submission model would require poll to return
   *  per-document results (`FiscalSubmitResult[]`). */
  submit(finalized: FinalizedFiscalDocument, cfg: EtaConfig): Promise<FiscalSubmitResult>;
  /** Polls a prior "submitted" result for its terminal accept/reject — see
   *  the one-document-per-submission note on submit(). */
  poll(submissionUuid: string, cfg: EtaConfig): Promise<FiscalSubmitResult>;
}
