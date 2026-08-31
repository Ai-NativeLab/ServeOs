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
