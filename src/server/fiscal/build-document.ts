import type {
  FiscalDocument,
  FiscalDocLine,
  FiscalSaleInput,
  FiscalRefundInput,
  FeeLineConfig,
} from "./provider";
import type { ProductTaxCode } from "./schema";
import type { Order } from "@/server/ordering/schema";
import type { OrderPayment } from "@/server/pos/tender-schema";
import { addDecimal, subtractDecimal, compareDecimal, divideDecimal, allocateLargestRemainder, isZeroDecimal, assertDecimal } from "./decimal";

/**
 * PURE document builders: a sale or refund plus its resolved
 * `product_tax_codes` in, a wire-agnostic `FiscalDocument` out. No HTTP, no
 * DB, no config — `./eta-wire` turns the result into receipt v1.2 JSON and
 * `./serialize` hashes it into a uuid.
 *
 * MONEY (F9): amounts are `money(n)` strings copied from the stored row. The
 * derivations that do happen exist because ETA's published validation rules
 * (https://sdk.invoicing.eta.gov.eg/main-calculations/) demand them, and all
 * of them run on scaled `bigint`s — never floats. See `allocateVat` for the
 * one place a stored total is split.
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

/**
 * A non-zero service charge or delivery fee with no fiscal classification.
 *
 * Receipt v1.2's own `feesAmount` slot "accepts only zero values", so a fee
 * can only reach ETA as its own `itemData` line — which needs an item code,
 * tax type and unit type exactly like a product does. Rather than drop the
 * money or invent a code, the build fails here and the tenant configures it.
 */
export class FeeLineConfigMissingError extends Error {
  constructor(readonly fee: "serviceCharge" | "delivery", readonly amount: string) {
    super(
      `fiscal: order carries a ${fee} of ${amount} but no feeLines.${fee} configuration. ` +
        "Receipt v1.2's feesAmount accepts only zero values, so a fee must be issued as its own receipt line with its own item/tax codes.",
    );
    this.name = "FeeLineConfigMissingError";
  }
}

/**
 * A refund with no lines cannot become a return receipt: `itemData` is
 * Mandatory on the return document, and `refunds` may legitimately exist
 * without `refund_lines` (a header-only full refund — see `issueRefund`,
 * which inserts lines only when the caller named them).
 */
export class EmptyReturnReceiptError extends Error {
  constructor(readonly refundId: string) {
    super(
      `fiscal: refund ${refundId} has no refund_lines, so there is no itemData to issue — ` +
        "receipt v1.2 marks itemData Mandatory. A header-only full refund needs its lines resolved from the parent order first.",
    );
    this.name = "EmptyReturnReceiptError";
  }
}

/**
 * The order's stored figures do not add up under either VAT convention, so no
 * document built from them could satisfy ETA's totalAmount equation.
 */
export class IrreconcilableOrderError extends Error {
  constructor(readonly orderId: string, readonly detail: string) {
    super(`fiscal: order ${orderId} cannot be reconciled into a receipt — ${detail}`);
    this.name = "IrreconcilableOrderError";
  }
}

/** ServeOS is single-currency; ETA requires an ISO 4217 code and, for a local
 *  Egyptian issuer, an exchangeRate only when the currency is not EGP. */
const CURRENCY = "EGP";

/** ETA's VAT tax-type code. */
const DEFAULT_TAX_TYPE = "T1";

/** ETA allows 5 decimal places on `unitPrice`; a VAT-inclusive net unit price
 *  needs them (see `buildLines`). */
const UNIT_PRICE_SCALE = 5;

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
 * Which VAT convention the stored figures were computed under, derived from
 * the row alone (`orders` does not persist the tenant's `pricesIncludeVat`
 * flag). `computeOrderTotals` (src/lib/order-totals.ts) leaves exactly one of
 * these two identities true, and the delivery fee is outside the taxable base
 * in both:
 *
 *   exclusive: total = subtotal + serviceCharge + vatAmount + deliveryFee
 *   inclusive: total = subtotal + serviceCharge + deliveryFee
 *
 * With no VAT the two coincide and either answer allocates nothing.
 */
function vatMode(order: Order): "inclusive" | "exclusive" {
  const taxable = addDecimal("taxable", order.subtotal, order.serviceChargeAmount ?? "0.00");
  const exclusive = addDecimal("total", taxable, order.vatAmount, order.deliveryFee);
  const inclusive = addDecimal("total", taxable, order.deliveryFee);

  if (compareDecimal(order.total, exclusive) === 0) return "exclusive";
  if (compareDecimal(order.total, inclusive) === 0) return "inclusive";
  throw new IrreconcilableOrderError(
    order.id,
    `stored total ${order.total} matches neither the VAT-exclusive total ${exclusive} nor the VAT-inclusive total ${inclusive} ` +
      `(subtotal ${order.subtotal}, serviceCharge ${order.serviceChargeAmount ?? "0.00"}, vat ${order.vatAmount}, delivery ${order.deliveryFee})`,
  );
}

/** One line's raw ingredients, before VAT is split across them. */
type LineDraft = {
  itemCode: string;
  codeSource: FiscalDocLine["codeSource"];
  taxType: string;
  taxSubType: string | null;
  unitType: string;
  description: string;
  internalCode: string;
  quantity: number;
  /** The line's amount before VAT is separated out, after every discount. */
  base: string;
  /** Discounts to report on the line: the line's own, plus its share of any
   *  order-level discount. */
  discounts: string[];
  /** Whether this line sits in the taxable base ServeOS actually taxed. */
  bearsVat: boolean;
};

function feeDraft(config: FeeLineConfig, amount: string, bearsVat: boolean): LineDraft {
  return {
    itemCode: config.itemCode,
    codeSource: config.codeSource,
    taxType: config.taxType,
    taxSubType: config.taxSubType,
    unitType: config.unitType,
    description: config.description,
    internalCode: config.internalCode,
    quantity: 1,
    base: amount,
    discounts: [],
    bearsVat,
  };
}

/**
 * The sale's lines, with `orders.discountAmount` pushed down onto them.
 *
 * ETA computes tax per line from that line's own base and validates (Main
 * Calculations) that
 *   taxableItems[T1].amount =
 *     (t2Amount + netSale + TotalTaxableFees[T5-T12] + valueDifference + t3Amount) * rate / 100
 * which reduces to `netSale * rate / 100` for ServeOS today, because we emit
 * no T2/T3 line taxes, no T5-T12 taxable fees and no valueDifference. ServeOS
 * applies the order-level discount BEFORE working out VAT. Reporting it as
 * `extraReceiptDiscountData` (which ETA subtracts AFTER tax) would therefore
 * misstate the tax base; allocating it across the lines it actually reduced
 * keeps every published equation true.
 */
function buildLineDrafts(input: FiscalSaleInput): LineDraft[] {
  const { order, items, taxCodes } = input;
  const codes = taxCodeIndex(taxCodes);

  const productShares = allocateLargestRemainder(
    "orderDiscount",
    assertDecimal(order.discountAmount, "orders.discountAmount"),
    items.map((item) => item.lineTotal),
  );

  const drafts: LineDraft[] = items.map((item, index) => {
    const code = requireTaxCode(codes, item.productId);
    const share = productShares[index];
    return {
      itemCode: code.itemCode,
      codeSource: code.codeSource,
      taxType: code.taxType,
      taxSubType: code.taxSubType,
      unitType: code.unitType,
      description: item.nameEn,
      internalCode: item.productId,
      quantity: item.quantity,
      base: subtractDecimal("line base", item.lineTotal, share),
      discounts: [item.discountAmount, share].filter((amount) => !isZeroDecimal(amount)),
      bearsVat: true,
    };
  });

  const serviceCharge = order.serviceChargeAmount ?? "0.00";
  if (!isZeroDecimal(serviceCharge)) {
    const config = input.feeLines?.serviceCharge;
    if (!config) throw new FeeLineConfigMissingError("serviceCharge", serviceCharge);
    // In the taxable base: computeOrderTotals taxes (subtotal + serviceCharge).
    drafts.push(feeDraft(config, serviceCharge, true));
  }

  if (!isZeroDecimal(order.deliveryFee)) {
    const config = input.feeLines?.delivery;
    if (!config) throw new FeeLineConfigMissingError("delivery", order.deliveryFee);
    // NOT in the taxable base: computeOrderTotals adds the delivery fee after
    // VAT, so this line carries no taxableItems at all. Emitting a zero T1
    // amount instead would break ETA's `amount = netSale * rate / 100` rule.
    drafts.push(feeDraft(config, order.deliveryFee, false));
  }

  return drafts;
}

/**
 * Splits `orders.vatAmount` across the VAT-bearing lines in proportion to
 * their amounts, by largest remainder, so the parts sum to the stored figure
 * EXACTLY. Lines outside ServeOS's taxable base get nothing.
 */
function allocateVat(order: Order, drafts: LineDraft[]): string[] {
  const bearing = drafts.map((draft) => (draft.bearsVat ? draft.base : "0.00"));
  if (isZeroDecimal(order.vatAmount)) return drafts.map(() => "0.00");

  const shares = allocateLargestRemainder("vatAmount", order.vatAmount, bearing);
  const zeroed = shares.map((share, index) => (drafts[index].bearsVat ? share : "0.00"));

  // Invariant, not decoration: ETA re-derives taxTotals as the sum of the
  // line taxes, so a drifting split would be rejected.
  const summed = addDecimal("vat split", ...zeroed);
  if (compareDecimal(summed, order.vatAmount) !== 0) {
    throw new IrreconcilableOrderError(order.id, `allocated VAT ${summed} does not equal stored vatAmount ${order.vatAmount}`);
  }
  return zeroed;
}

/**
 * ETA Payment Methods (https://sdk.invoicing.eta.gov.eg/codes/payment-methods/):
 * C Cash | V Visa | CC Cash with contractor | VC Visa with contractor |
 * VO Vouchers | PR Promotion | GC Gift Card | P Points | O Others.
 */
function tenderCode(method: OrderPayment["method"]): string {
  switch (method) {
    // Table row "C | Cash".
    case "cash": return "C";
    // Table row "V | Visa" — the only card row in ETA's table, so every card
    // scheme reports as V. Worth revisiting if ETA publishes a generic code.
    case "card": return "V";
    // Table row "O | Others".
    default: return "O";
  }
}

/**
 * Receipt v1.2 carries ONE `paymentMethod` per document (String(50), not a
 * collection), so a split payment has to resolve to a single code: the
 * largest tender wins, ties going to the first recorded.
 *
 * Web orders have no `order_payments` rows (that table is POS-only), so they
 * fall back to `orders.paymentMethod`, whose instapay/wallet values have no
 * counterpart in ETA's table and therefore report as "O | Others".
 */
function paymentMethodCode(order: Order, payments: OrderPayment[]): string {
  if (payments.length > 0) {
    const largest = payments.reduce((best, payment) => (compareDecimal(payment.amount, best.amount) > 0 ? payment : best));
    return tenderCode(largest.method);
  }
  return order.paymentMethod === "cash" ? "C" : "O";
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
 * configured value (150000 EGP)", and Main Calculations adds that a P-type
 * id must be 14 digits. Above that threshold this document would be rejected;
 * capturing a national ID is deferred to the fiscal config work, and nothing
 * here invents one.
 */
export function buildReceipt(input: FiscalSaleInput): FiscalDocument {
  const { order } = input;
  const mode = vatMode(order);
  const drafts = buildLineDrafts(input);
  const vatShares = allocateVat(order, drafts);

  const lines: FiscalDocLine[] = drafts.map((draft, index) => {
    const vat = vatShares[index];
    // netSale is tax-EXCLUSIVE by ETA's definition, so VAT-inclusive prices
    // have their allocated tax taken back out; exclusive prices pass through
    // untouched (F9).
    const netSale = mode === "inclusive" ? subtractDecimal("netSale", draft.base, vat) : draft.base;
    const discountTotal = addDecimal("line discounts", ...draft.discounts, "0.00");
    // Main Calculations: "netSale = totalSale - Sum(commercialDiscountData.amount)".
    const totalSale = addDecimal("totalSale", netSale, discountTotal);
    // Main Calculations: "totalSale = quantity * unitPrice" — so the unit
    // price is ALWAYS derived from the line's own totalSale, never taken from
    // the stored column. `order_items.unitBasePrice` excludes modifier price
    // deltas for a plain product line (ordering/service.ts stores the base,
    // with the deltas only in selectedModifiers) while `lineTotal` includes
    // them, so passing it through would break the equation on any modified
    // line; VAT-inclusive pricing needs a net price for the same reason.
    // 5 decimal places is the precision ETA permits on unitPrice.
    const unitPrice = divideDecimal("unitPrice", totalSale, String(draft.quantity), UNIT_PRICE_SCALE);

    return {
      itemCode: draft.itemCode,
      internalCode: draft.internalCode,
      codeSource: draft.codeSource,
      taxType: draft.taxType,
      taxSubType: draft.taxSubType,
      unitType: draft.unitType,
      description: draft.description,
      quantity: draft.quantity,
      unitPrice,
      discountAmount: discountTotal,
      taxes: isZeroDecimal(vat)
        ? []
        : [{ taxType: draft.taxType, taxSubType: draft.taxSubType, rate: order.vatRateSnapshot, amount: vat }],
      lineTotal: netSale,
    };
  });

  return {
    docType: "e_receipt",
    uuid: null,
    previousUuid: input.previousUuid,
    referenceUuid: null,
    referenceOldUuid: null,
    buyer: { type: "P" },
    lines,
    subtotal: order.subtotal,
    // The order-level discount now rides on the lines (see buildLineDrafts),
    // so there is no receipt-level discount left for ETA to subtract.
    discountTotal: "0.00",
    // The semantic sum of both fee columns, kept for the contract's sake; the
    // fees themselves ship as their own lines above and the wire's feesAmount
    // is always zero.
    feesTotal: addDecimal("feesTotal", order.serviceChargeAmount ?? "0.00", order.deliveryFee),
    taxTotals: isZeroDecimal(order.vatAmount)
      ? []
      : [
          {
            taxType: drafts.find((draft) => draft.bearsVat)?.taxType ?? DEFAULT_TAX_TYPE,
            taxSubType: drafts.find((draft) => draft.bearsVat)?.taxSubType ?? null,
            rate: order.vatRateSnapshot,
            amount: order.vatAmount,
          },
        ],
    total: order.total,
    paymentMethodCode: paymentMethodCode(order, input.payments),
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
 * NO VAT IS REVERSED — a live fiscal exposure, not an oversight. `refunds`
 * and `refund_lines` store only an amount (no vatAmount, no rate, no per-line
 * tax), so there is no stored figure to reverse and deriving one here would
 * be inventing tax. The return therefore declares `netAmount == totalAmount`
 * with no `taxableItems`, which means a tenant issuing returns
 * OVER-DECLARES output VAT: the sale's VAT was reported in full and none of
 * it is credited back. Fixing this properly needs VAT figures persisted at
 * the refund layer (Spec 3); see addendum section 6.
 */
export function buildReturnReceipt(input: FiscalRefundInput): FiscalDocument {
  const { refund, lines: refundLines, items, taxCodes } = input;
  if (refundLines.length === 0) throw new EmptyReturnReceiptError(refund.id);
  const codes = taxCodeIndex(taxCodes);
  const itemsById = new Map(items.map((item) => [item.id, item]));

  const lines: FiscalDocLine[] = refundLines.map((refundLine) => {
    const item = itemsById.get(refundLine.orderItemId);
    if (!item) {
      throw new Error(`fiscal: refund line ${refundLine.id} references order item ${refundLine.orderItemId}, which was not supplied`);
    }
    const code = requireTaxCode(codes, item.productId);
    return {
      itemCode: code.itemCode,
      internalCode: item.productId,
      codeSource: code.codeSource,
      taxType: code.taxType,
      taxSubType: code.taxSubType,
      unitType: code.unitType,
      description: item.nameEn,
      quantity: refundLine.quantity,
      unitPrice: divideDecimal("unitPrice", refundLine.amount, String(refundLine.quantity), UNIT_PRICE_SCALE),
      discountAmount: "0.00",
      taxes: [],
      lineTotal: refundLine.amount,
    };
  });

  return {
    docType: "return_receipt",
    uuid: null,
    previousUuid: input.previousUuid,
    referenceUuid: input.parentUuid,
    referenceOldUuid: null,
    buyer: { type: "P" },
    lines,
    subtotal: addDecimal("subtotal", ...lines.map((line) => line.lineTotal), "0.00"),
    discountTotal: "0.00",
    feesTotal: "0.00",
    taxTotals: [],
    total: refund.totalAmount,
    // A refund reverses the sale's tender; ServeOS records the outgoing
    // method on `refund_payments`, which this input does not carry, so the
    // conservative "Others" code applies until it does.
    paymentMethodCode: "O",
    currency: CURRENCY,
    issuedAt: toEtaUtc(refund.createdAt),
  };
}
