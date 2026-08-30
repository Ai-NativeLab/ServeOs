import type { FiscalDocument, FiscalDocLine, FiscalSaleInput, FiscalRefundInput } from "./provider";
import type { ProductTaxCode } from "./schema";
import type { OrderItem } from "@/server/ordering/schema";
import { addDecimal } from "./decimal";

/**
 * PURE document builders: a sale or refund plus its resolved
 * `product_tax_codes` in, a wire-agnostic `FiscalDocument` out. No HTTP, no
 * DB, no config — `./eta-wire` turns the result into receipt v1.2 JSON and
 * `./serialize` hashes it into a uuid.
 *
 * MONEY (F9): every amount is a `money(n)` string copied verbatim from the
 * stored row. Nothing here re-derives a total; the two additions that do
 * happen (`feesTotal`, the return receipt's subtotal) are exact decimal sums
 * over stored columns, never float arithmetic — see ./decimal.
 */

/** A product with no `product_tax_codes` row cannot appear on a fiscal
 *  document at all: ETA's itemData requires itemCode/itemType/unitType/taxType
 *  and we will not guess them. The worker turns this into a `failed`
 *  submission row plus an owner alert — never a blocked sale. */
export class MissingTaxCodeError extends Error {
  constructor(readonly productId: string) {
    super(`fiscal: product ${productId} has no product_tax_codes row — cannot build a fiscal document line`);
    this.name = "MissingTaxCodeError";
  }
}

/** ServeOS is single-currency; ETA requires an ISO 4217 code and, for a local
 *  Egyptian issuer, an exchangeRate only when the currency is not EGP. */
const CURRENCY = "EGP";

/** ETA's VAT tax-type code, used when a tenant's tax codes do not agree on
 *  one (they always should — the fallback exists so a document is still
 *  buildable rather than throwing on a data inconsistency). */
const DEFAULT_TAX_TYPE = "T1";

/**
 * ETA's `dateTimeIssued` examples are second precision (`2022-02-03T00:00:00Z`)
 * and the same value is echoed into the QR url, so milliseconds are trimmed
 * here rather than at each consumer.
 */
function toEtaUtc(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

function taxCodeIndex(taxCodes: ProductTaxCode[]): Map<string, ProductTaxCode> {
  return new Map(taxCodes.map((code) => [code.productId, code]));
}

function requireTaxCode(codes: Map<string, ProductTaxCode>, productId: string): ProductTaxCode {
  const code = codes.get(productId);
  if (!code) throw new MissingTaxCodeError(productId);
  return code;
}

/**
 * One document line from one order line + its tax code. `quantity`,
 * `unitPrice`, `discountAmount` and `lineTotal` all come straight off the
 * stored row.
 *
 * `taxes` is empty: ServeOS persists VAT once per order
 * (`orders.vatAmount`/`vatRateSnapshot`), never per line, so there is no
 * per-line split to map. ETA's line-level `taxableItems` is Optional, so the
 * omission is schema-valid — but see the note on `toWireReceipt` about ETA's
 * totals reconciliation.
 */
function toDocLine(item: OrderItem, code: ProductTaxCode, quantity: number, lineTotal: string): FiscalDocLine {
  return {
    itemCode: code.itemCode,
    codeSource: code.codeSource,
    taxType: code.taxType,
    taxSubType: code.taxSubType,
    unitType: code.unitType,
    description: item.nameEn,
    quantity,
    unitPrice: item.unitBasePrice,
    discountAmount: item.discountAmount,
    taxes: [],
    lineTotal,
  };
}

/**
 * A completed sale as an ETA e-receipt.
 *
 * `uuid` is null: a receipt's uuid is the SHA-256 of its own *serialized wire
 * document*, so it cannot exist before the wire mapping — `finalizeReceipt`
 * (./serialize) computes it and writes it back.
 *
 * BUYER: restaurant sales are walk-in, so the buyer defaults to `{ type: "P" }`
 * (natural person) with no id or name. Receipt v1.2 makes buyer id + name
 * Mandatory when "type is P and totalAmount equals to or greater than a
 * configured value (150000 EGP)" — above that threshold this document would be
 * rejected. Capturing and threading the buyer's national ID is deferred to the
 * fiscal config work (Task 3b/6); nothing here silently invents one.
 */
export function buildReceipt(input: FiscalSaleInput): FiscalDocument {
  const { order, items, taxCodes } = input;
  const codes = taxCodeIndex(taxCodes);

  const lines = items.map((item) => {
    const code = requireTaxCode(codes, item.productId);
    return toDocLine(item, code, item.quantity, item.lineTotal);
  });

  // ETA offers ONE fees slot per receipt but ServeOS stores two fee columns,
  // so this single field is a deliberate exact-decimal sum of both (a
  // coordinator decision — every other amount below is verbatim). Note that
  // receipt v1.2's feesAmount "accepts only zero values", so ./eta-wire
  // refuses to emit a non-zero total rather than send an invalid document.
  const feesTotal = addDecimal("feesTotal", order.serviceChargeAmount ?? "0.00", order.deliveryFee);

  return {
    docType: "e_receipt",
    uuid: null,
    previousUuid: input.previousUuid,
    referenceUuid: null,
    referenceOldUuid: null,
    buyer: { type: "P" },
    lines,
    subtotal: order.subtotal,
    discountTotal: order.discountAmount,
    feesTotal,
    taxTotals: [
      {
        taxType: lines[0]?.taxType ?? DEFAULT_TAX_TYPE,
        taxSubType: lines[0]?.taxSubType ?? null,
        rate: order.vatRateSnapshot,
        amount: order.vatAmount,
      },
    ],
    total: order.total,
    currency: CURRENCY,
    issuedAt: toEtaUtc(order.placedAt),
  };
}

/**
 * A refund as an ETA return receipt.
 *
 * AMOUNTS ARE POSITIVE. Return Receipt v1.2 describes totalSales / netAmount /
 * totalAmount in exactly the same words as the sale receipt and defines no
 * negative-amount convention anywhere; the document is identified as a return
 * by `documentType.receiptType = "r"` plus the Mandatory `referenceUUID`
 * pointing at the original sale receipt. So the sign convention is: none.
 *
 * A partial refund produces a partial document — only the refunded lines, at
 * the refunded quantity and amount.
 *
 * `taxTotals` is empty: `refunds`/`refund_lines` store a single amount per
 * line with no VAT split, so there is no stored tax figure to map and this
 * builder will not derive one (F9).
 */
export function buildReturnReceipt(input: FiscalRefundInput): FiscalDocument {
  const { refund, lines: refundLines, items, taxCodes } = input;
  const codes = taxCodeIndex(taxCodes);
  const itemsById = new Map(items.map((item) => [item.id, item]));

  const lines = refundLines.map((refundLine) => {
    const item = itemsById.get(refundLine.orderItemId);
    if (!item) {
      throw new Error(`fiscal: refund line ${refundLine.id} references order item ${refundLine.orderItemId}, which was not supplied`);
    }
    const code = requireTaxCode(codes, item.productId);
    return toDocLine(item, code, refundLine.quantity, refundLine.amount);
  });

  return {
    docType: "return_receipt",
    uuid: null,
    previousUuid: input.previousUuid,
    referenceUuid: input.parentUuid,
    referenceOldUuid: null,
    buyer: { type: "P" },
    lines,
    subtotal: addDecimal("subtotal", ...lines.map((line) => line.lineTotal)),
    discountTotal: "0.00",
    feesTotal: "0.00",
    taxTotals: [],
    total: refund.totalAmount,
    currency: CURRENCY,
    issuedAt: toEtaUtc(refund.createdAt),
  };
}
