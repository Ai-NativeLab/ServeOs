import type { EtaDocType, EtaEnvironment, EtaCodeSource, ProductTaxCode } from "./schema";
import type { Order, OrderItem } from "@/server/ordering/schema";
import type { Refund, RefundLine } from "@/server/pos/refund-schema";

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
  currency: string;
  /** ISO-8601 UTC. */
  issuedAt: string;
};

/**
 * The sale + its resolved `ProductTaxCode[]` + chain inputs needed to build
 * an e-receipt `FiscalDocument`. Task 3 may ADD fields here as the builder's
 * needs emerge — `order`/`items` are already the real row types.
 */
export type FiscalSaleInput = {
  order: Order;
  items: OrderItem[];
  taxCodes: ProductTaxCode[];
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
 * Mapping to `eta_submission_status`: a thrown error = retryable transport
 * failure (worker records "failed" + backoff); "skipped" = no submission
 * row is written at all; "submitted" = 202 accepted-for-processing,
 * terminal accept/reject arrives via poll.
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
  registrationNumber: string;
  environment: EtaEnvironment; // "preprod" | "prod"
  erp: { clientId: string; clientSecret: string };
  device: EtaDeviceCredentials | null;
  /** e-seal signing material — B2B only; unused for receipts today. */
  signingKey: string | null;
};

/**
 * `buildCreditNote` (B2B e_invoice corrections) is deliberately absent —
 * deferred with the B2B trigger; adding it later is a breaking change to
 * every implementer, accepted cost.
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
  submit(doc: FiscalDocument, cfg: EtaConfig): Promise<FiscalSubmitResult>;
  /** Polls a prior "submitted" result for its terminal accept/reject — see
   *  the one-document-per-submission note on submit(). */
  poll(submissionUuid: string, cfg: EtaConfig): Promise<FiscalSubmitResult>;
}
