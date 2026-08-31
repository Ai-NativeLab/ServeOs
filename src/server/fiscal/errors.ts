/**
 * Every way building a fiscal document can fail.
 *
 * These are all PERMANENT document-construction failures: the inputs cannot
 * produce a valid ETA document, so no amount of retrying will ever fix one.
 * Task 5's worker maps `instanceof FiscalDocumentError` to a submission row
 * with status "failed" and `lastError = message`, with NO backoff and no
 * further attempts — as opposed to a transport error, which is retryable.
 * The `code` is the stable, machine-readable discriminator for that mapping
 * and for owner-facing alerts; the message is for humans reading the row.
 *
 * Deliberately NOT the house `DomainError`. A fiscal failure is never
 * user-facing and must never block a sale: the money is already taken and the
 * receipt already printed by the time any of this runs. It surfaces to the
 * tenant's owner as an alert to fix configuration (a missing tax code, an
 * unconfigured fee line), not to the cashier as a checkout error.
 *
 * This is ONE of three failure families — see the FAILURE TAXONOMY table on
 * `FiscalProvider` in `./provider` for all three and the worker behaviour each
 * one requires.
 */
export abstract class FiscalDocumentError extends Error {
  abstract readonly code: string;
}

/** A product with no `product_tax_codes` row cannot appear on a fiscal
 *  document at all: ETA's itemData requires itemCode/itemType/unitType/taxType
 *  and we will not guess them. */
export class MissingTaxCodeError extends FiscalDocumentError {
  readonly code = "missing-tax-code";
  constructor(readonly productId: string) {
    super(`fiscal: product ${productId} has no product_tax_codes row — cannot build a fiscal document line`);
    this.name = "MissingTaxCodeError";
  }
}

/**
 * A non-zero service charge or delivery fee with no fiscal classification.
 *
 * Receipt v1.2's own `feesAmount` slot "accepts only zero values", so a fee
 * can only reach ETA as its own `itemData` line — which needs an item code,
 * tax type and unit type exactly like a product does. Rather than drop the
 * money or invent a code, the build fails here and the tenant configures it.
 */
export class FeeLineConfigMissingError extends FiscalDocumentError {
  readonly code = "fee-line-config-missing";
  constructor(readonly fee: "serviceCharge" | "delivery", readonly amount: string) {
    super(
      `fiscal: order carries a ${fee} of ${amount} but no feeLines.${fee} configuration. ` +
        "Receipt v1.2's feesAmount accepts only zero values, so a fee must be issued as its own receipt line with its own item/tax codes.",
    );
    this.name = "FeeLineConfigMissingError";
  }
}

/**
 * The order's stored figures do not add up under either VAT convention, so no
 * document built from them could satisfy ETA's totalAmount equation.
 */
export class IrreconcilableOrderError extends FiscalDocumentError {
  readonly code = "irreconcilable-order";
  constructor(readonly orderId: string, readonly detail: string) {
    super(`fiscal: order ${orderId} cannot be reconciled into a receipt — ${detail}`);
    this.name = "IrreconcilableOrderError";
  }
}

/**
 * A refund with no lines cannot become a return receipt: `itemData` is
 * Mandatory on the return document, and `refunds` may legitimately exist
 * without `refund_lines` (a header-only full refund — see `issueRefund`,
 * which inserts lines only when the caller named them).
 */
export class EmptyReturnReceiptError extends FiscalDocumentError {
  readonly code = "empty-return-receipt";
  constructor(readonly refundId: string) {
    super(
      `fiscal: refund ${refundId} has no refund_lines, so there is no itemData to issue — ` +
        "receipt v1.2 marks itemData Mandatory. A header-only full refund needs its lines resolved from the parent order first.",
    );
    this.name = "EmptyReturnReceiptError";
  }
}

/** A refund line pointing at an order item the caller did not supply — the
 *  description, unit price and productId a document line needs all come from
 *  that item, so the refund cannot be mapped without it. */
export class RefundLineOrphanError extends FiscalDocumentError {
  readonly code = "refund-line-orphan";
  constructor(readonly refundLineId: string, readonly orderItemId: string) {
    super(`fiscal: refund line ${refundLineId} references order item ${orderItemId}, which was not supplied`);
    this.name = "RefundLineOrphanError";
  }
}

/**
 * The emitted document breaks ETA's published totals equation, so it would be
 * rejected (or worse, silently misfile tax). Thrown instead of transmitting.
 */
export class EtaTotalsMismatchError extends FiscalDocumentError {
  readonly code = "eta-totals-mismatch";
  constructor(readonly expected: string, readonly actual: string, readonly equation: string) {
    super(`fiscal: emitted document fails ETA's ${equation} — expected ${expected}, computed ${actual}`);
    this.name = "EtaTotalsMismatchError";
  }
}

/**
 * A refund whose LINE AMOUNTS are disproportionate to the VAT distribution
 * stored against them, by more than ETA's own tolerance.
 *
 * ETA taxes each line on its own base (Main Calculations rule 42), so a line
 * may carry only the tax the money it returns contains — and by the same token
 * it must carry roughly ALL of it. `issueRefund` never validates a FULL
 * refund's line amounts against its tenders or against the items those lines
 * name, so a refund can legitimately record amounts pointing the opposite way
 * to the VAT its items bear (`refund-vat.ts` stage [5] floors the resulting
 * negative shares at zero, which is what leaves one line holding a token amount
 * of tax against a large amount of money).
 *
 * The document is refused rather than emitted: reporting the stored split would
 * be rejected by ETA, and re-proportioning it here would be inventing an
 * attribution the refund never made. This is thrown by the BUILDER, ahead of
 * the wire's own per-line check, so the owner is told the cause (the refund's
 * shape) rather than the symptom (a failed equation).
 */
export class DisproportionateRefundLineError extends FiscalDocumentError {
  readonly code = "disproportionate-refund-line";
  constructor(
    readonly refundId: string,
    readonly lineAmount: string,
    readonly lineVat: string,
    readonly capacity: string,
  ) {
    super(
      `fiscal: refund ${refundId} returns ${lineAmount} on a line carrying only ${lineVat} of VAT, where the money itself ` +
        `contains ${capacity}. ETA taxes every return line on its own netSale (Main Calculations rule 42, ± 0.5), so this ` +
        "refund's line amounts are distributed differently from the VAT stored against them — typically because a full " +
        "refund's line amounts were entered out of proportion to the items, or mixed with an earlier goodwill refund. " +
        "Reissue it as a headerless full refund, which needs no per-line split.",
    );
    this.name = "DisproportionateRefundLineError";
  }
}

/**
 * A `taxableItems` entry whose amount is not strictly positive.
 *
 * Main Calculations pins a line's tax to its own base — rule 42:
 * `taxableItems[T1].amount = (... + netSale + ...) * rate / 100` — so a ZERO
 * amount at a non-zero rate is arithmetically false and a NEGATIVE one is an
 * invented input tax credit on a document that is already a reversal. Round 1
 * settled the zero case by OMITTING the entry entirely (a line with no tax
 * carries no `taxableItems`), which leaves nothing legitimate for this to
 * refuse: it is the belt-and-braces guard that a future allocation bug cannot
 * quietly file negative tax.
 */
export class NonPositiveLineTaxError extends FiscalDocumentError {
  readonly code = "non-positive-line-tax";
  constructor(readonly lineIndex: number, readonly taxType: string, readonly amount: string) {
    super(
      `fiscal: itemData[${lineIndex}].taxableItems[${taxType}].amount is ${amount} — ETA derives a line's tax from its own netSale ` +
        "(Main Calculations rule 42), so a zero-amount entry is omitted rather than emitted and a negative one would claim tax back that was never charged.",
    );
    this.name = "NonPositiveLineTaxError";
  }
}

/**
 * A tax type this mapper does not know how to total correctly.
 *
 * Main Calculations gives the line total as
 *   total = netSale + t1 + t2 + t3 + TotalTaxableFees[T5-T12]
 *           - Sum(itemDiscountData) - Sum(additionalItemDiscount) - t4
 *           + NonTotalTaxableFees[T13-T20]
 * so T4 is SUBTRACTED while every other tax type is added. The line-total
 * helper only knows how to add, so a T4 classification would silently
 * overstate the line (and the receipt) rather than fail. Supporting
 * withholding tax is deliberate work, not a one-character change — until then
 * it is refused.
 */
export class UnsupportedTaxTypeError extends FiscalDocumentError {
  readonly code = "unsupported-tax-type";
  constructor(readonly taxType: string) {
    super(
      `fiscal: tax type ${taxType} is not supported by this mapper. ` +
        "ETA's line-total equation subtracts T4 (withholding) where every other type is added, so totalling it here would misstate the document.",
    );
    this.name = "UnsupportedTaxTypeError";
  }
}

/** `taxableItems[].subType` is Mandatory in receipt v1.2, so a line tax
 *  without one is a data error rather than something to paper over. */
export class MissingTaxSubTypeError extends FiscalDocumentError {
  readonly code = "missing-tax-sub-type";
  constructor(readonly taxType: string, readonly index: number) {
    super(`fiscal: line tax #${index} (${taxType}) has no taxSubType, which receipt v1.2 marks Mandatory on taxableItems`);
    this.name = "MissingTaxSubTypeError";
  }
}

/** A return receipt with no `referenceUUID` — Mandatory in v1.2, and the only
 *  thing tying the return to the sale it reverses. */
export class MissingReferenceUuidError extends FiscalDocumentError {
  readonly code = "missing-reference-uuid";
  constructor() {
    super("fiscal: a return receipt requires referenceUUID — the uuid of the original sale receipt (Mandatory in v1.2)");
    this.name = "MissingReferenceUuidError";
  }
}

/**
 * Receipt v1.2 makes `buyer.id` AND `buyer.name` Mandatory together for a
 * business buyer, and for a natural person once the receipt reaches ETA's
 * configured threshold. ServeOS issues walk-in `P` receipts with neither, so a
 * large enough sale must fail here rather than be rejected after submission.
 */
export class BuyerIdRequiredError extends FiscalDocumentError {
  readonly code = "buyer-id-required";
  constructor(
    readonly buyerType: string,
    readonly total: string,
    readonly threshold: string,
    readonly missing: string[],
  ) {
    super(
      `fiscal: buyer type ${buyerType} is missing ${missing.map((field) => `buyer.${field}`).join(" and ")} ` +
        `on a receipt of ${total} (threshold ${threshold}). ` +
        "Receipt v1.2 makes BOTH id and name Mandatory for type B, and for type P at or above the ETA-configured amount.",
    );
    this.name = "BuyerIdRequiredError";
  }
}
