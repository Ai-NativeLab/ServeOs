import type { EtaDocType, EtaEnvironment, EtaCodeSource, ProductTaxCode } from "./schema";

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
  /** `money(n)` string, mapped verbatim from the sale/refund. */
  total: string;
  currency: string;
  /** ISO-8601 UTC. */
  issuedAt: string;
};

/**
 * The sale + its resolved `ProductTaxCode[]` + chain inputs needed to build
 * an e-receipt `FiscalDocument`.
 *
 * `order`/`items` stay `unknown` here — Task 3 tightens them to the real
 * ordering-domain shapes once the builder is implemented.
 */
export type FiscalSaleInput = {
  order: unknown;
  items: unknown[];
  taxCodes: ProductTaxCode[];
  previousUuid: string;
  deviceSerial: string | null;
};

/**
 * The refund + its resolved `ProductTaxCode[]` + chain inputs needed to
 * build a return-receipt `FiscalDocument` (B2C refund; B2B credit_note is
 * deferred).
 *
 * `refund`/`lines` stay `unknown` here — Task 3 tightens them to the real
 * refund-domain shapes once the builder is implemented.
 */
export type FiscalRefundInput = {
  parentUuid: string;
  refund: unknown;
  lines: unknown[];
  taxCodes: ProductTaxCode[];
  previousUuid: string;
  deviceSerial: string | null;
};

export type FiscalSubmitResult = {
  /** "submitted" = HTTP 202 accepted-for-processing; terminal accept/reject
   *  arrives via poll(). */
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

export interface FiscalProvider {
  readonly name: string; // "eta" | "noop"
  /** Pure: builds an e-receipt FiscalDocument, no I/O. */
  buildReceipt(input: FiscalSaleInput): FiscalDocument;
  /** Pure: builds a return-receipt FiscalDocument, no I/O. */
  buildReturnReceipt(input: FiscalRefundInput): FiscalDocument;
  /** Submits a built document. May return a terminal result or, under the
   *  202-then-poll model, a "submitted" result to be resolved via poll(). */
  submit(doc: FiscalDocument, cfg: EtaConfig): Promise<FiscalSubmitResult>;
  /** Polls a prior "submitted" submission for its terminal accept/reject. */
  poll(submissionUuid: string, cfg: EtaConfig): Promise<FiscalSubmitResult>;
}
