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
import {
  addDecimal, sumDecimal, subtractDecimal, compareDecimal, divideDecimal,
  multiplyDecimal, allocateLargestRemainder, isZeroDecimal, assertDecimal, hundredAtRateScale,
} from "./decimal";
import {
  MissingTaxCodeError, FeeLineConfigMissingError, IrreconcilableOrderError,
  EmptyReturnReceiptError, RefundLineOrphanError,
} from "./errors";

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
  const summed = sumDecimal("vat split", zeroed);
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
    const discountTotal = sumDecimal("line discounts", draft.discounts);
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
 * Which convention a REFUND's stored line amounts were written in, and
 * therefore how much tax each one can carry.
 *
 * `refund_lines.amount` is copied from `order_items.lineTotal` by both refund
 * surfaces (`apps/pos/src/screens/SalesHistory.tsx` builds a line as
 * `amount: Number(r.item.lineTotal)`), so it inherits the ORDER's convention:
 * gross under VAT-inclusive pricing, net under VAT-exclusive pricing. The two
 * make opposite documents — under `"gross"` the reversed tax comes OUT of the
 * line's amount, under `"net"` it goes ON TOP — so the choice is what decides
 * whether ETA's `totalAmount = Sum(itemData.total)` holds.
 */
type ReturnAmountBasis = "gross" | "net";

/** The tax a line of `amount` may carry under `basis`, per Main Calculations
 *  rule 42 (`amount = netSale * rate / 100`), 2dp half-up:
 *
 *    net    netSale IS the amount        ->  amount * rate / 100
 *    gross  netSale is the amount minus  ->  amount * rate / (100 + rate)
 *           the tax inside it
 *
 *  It is a CEILING as much as a value: a line cannot honestly report more tax
 *  than the money it accounts for contains, and reporting more is precisely
 *  what ETA's per-line equation rejects. */
function lineTaxCapacity(amount: string, rate: string, basis: ReturnAmountBasis): string {
  return divideDecimal(
    "line tax capacity",
    multiplyDecimal("line tax capacity", amount, rate),
    basis === "net" ? hundredAtRateScale(rate) : addDecimal("line tax capacity", "100", rate),
    2,
  );
}

/** One return line before its VAT is settled. */
type ReturnDraft = {
  line: Omit<FiscalDocLine, "unitPrice" | "taxes" | "lineTotal">;
  /** The money this line accounts for — `refund_lines.amount`, or the
   *  unattributed remainder, verbatim. Read under `ReturnAmountBasis`. */
  amount: string;
  /** What the refund domain stored against it (`refund_lines.vatAmount`). The
   *  remainder line stores nothing, so it claims only from the residual. */
  storedVat: string;
};

/**
 * Spreads a refund's stored VAT across the lines that will report it, with no
 * line ever pushed past the tax its own money contains.
 *
 * Each line starts from its STORED figure (capped), and whatever the caps hold
 * back is re-offered to the lines that still have headroom — which is how the
 * service charge's share, which the refund domain tops into item lines it has
 * no other home for, lands on the line that actually carries its money.
 *
 * `unreported` is what no line could take. It is zero for every refund whose
 * money and VAT agree; see THE DOCUMENT'S VAT CEILING on `buildReturnReceipt`
 * for the one shape where it is not.
 */
function attributeReturnVat(
  drafts: ReturnDraft[], headerVat: string, rate: string, basis: ReturnAmountBasis,
): { vats: string[]; unreported: string } {
  const caps = drafts.map((draft) => lineTaxCapacity(draft.amount, rate, basis));
  const base = drafts.map((draft, index) =>
    compareDecimal(draft.storedVat, caps[index]) > 0 ? caps[index] : draft.storedVat);

  const residual = subtractDecimal("return VAT residual", headerVat, sumDecimal("return line VAT", base));
  if (isZeroDecimal(residual)) return { vats: base, unreported: "0.00" };
  if (compareDecimal(residual, "0") < 0) {
    // The lines store MORE than the refund itself does — `issueRefund` makes
    // that unreachable (Σ lines IS the header for an itemised refund, and the
    // resolved lines of a headerless one are built to sum to it), so this is a
    // corrupted row rather than a shape to honour. Shrink to the header
    // proportionally rather than reporting past it; every part only moves down,
    // so no line is pushed over its cap, and `assertTotalsReconcile` still has
    // the last word on whether the result is emittable at all.
    return { vats: allocateLargestRemainder("refunds.vatAmount", headerVat, base), unreported: "0.00" };
  }

  const headroom = base.map((vat, index) => subtractDecimal("return VAT headroom", caps[index], vat));
  const available = sumDecimal("return VAT headroom", headroom);
  const placed = compareDecimal(residual, available) > 0 ? available : residual;
  const extra = allocateLargestRemainder("return VAT residual", placed, headroom);

  return {
    vats: base.map((vat, index) => addDecimal("return line VAT", vat, extra[index])),
    unreported: subtractDecimal("unreported return VAT", residual, placed),
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
 * ---------------------------------------------------------------------------
 * HOW THE VAT IS REVERSED (round 2 Task 2 — this closes the round-1 exposure
 * where a return carried no `taxableItems` at all, so every EG tenant issuing
 * refunds over-declared output VAT).
 *
 * THE MONEY IS MAPPED, NEVER DERIVED (F9). `total` is `refunds.totalAmount` and
 * every line's money is `refund_lines.amount`, both verbatim; the reversed tax
 * starts from `refunds.vatAmount` and `refund_lines.vatAmount`, the figures
 * `issueRefund` computed ONCE from the order's own stored VAT (see
 * `@/server/pos/refund-vat`). Nothing here re-derives how much a refund gave
 * back — it decides only which LINE reports which part of the tax, because ETA
 * validates that per line and the refund domain does not.
 *
 * WHY PER-LINE ATTRIBUTION IS NOT SIMPLY THE STORED PER-LINE FIGURE. Main
 * Calculations rule 42 ties a line's tax to its OWN base — quoted in full on
 * `assertLineTaxesDerivable` in `./eta-wire` — within ETA's published
 * "(± 0.5) tolerance". The refund domain deliberately breaks that for one
 * shape: an itemised FULL refund TOPS UP its line VATs with the service
 * charge's share, because that share belongs to the refund and has no product
 * line of its own (`refund-vat.ts`, stage [4]). A 150.00 line topped up to
 * 20.26 at 14% reports netSale 129.74, which rule 42 prices at 18.16 — off by
 * 2.10, four times ETA's allowance, and rejected.
 *
 * SO THE TOP-UP IS UN-DONE AT THE WIRE, ONTO THE MONEY IT CAME FROM. Each
 * product line is capped at the tax its own amount contains, and the money the
 * refund returned that no `refund_lines` row names —
 * `refunds.totalAmount - Σ line amounts`, which is the order-level service
 * charge — becomes its OWN return line carrying the capped-off remainder. That
 * is the same fees-as-item-lines decision the sale side already makes, with the
 * same `feeLines.serviceCharge` classification and the same
 * `FeeLineConfigMissingError` when a tenant has not configured one. In the
 * example above the item line reports 18.42 on netSale 131.58 and the
 * service-charge line 1.84 on netSale 13.16: both exact under rule 42, and
 * 18.42 + 1.84 = 20.26 = the stored header, to the cent.
 *
 * NOTHING CHANGES FOR THE ORDINARY REFUND. A partial refund's stored line VAT
 * already IS the tax inside that line's money (the refund domain allocates it
 * over the same `lineTotal`s), so cap and stored coincide, the stored figure
 * ships verbatim and there is no extra line at all. The de-topping only ever
 * moves the cents the refund domain could not attribute honestly in the first
 * place.
 *
 * NET VS GROSS LINE AMOUNTS. Both refund surfaces copy a line's amount from
 * `order_items.lineTotal`, so the amounts are gross under VAT-inclusive pricing
 * and NET under VAT-exclusive pricing — where the reversed tax has to be added
 * ON TOP of the line rather than taken out of it. `basis` picks whichever
 * reading makes ETA's `totalAmount = Sum(itemData.total)` hold against the
 * stored refund total, preferring the order's own convention (`vatMode`) and
 * falling back to gross when the net reading would over-run the money the
 * refund actually paid out.
 *
 * THE DOCUMENT'S VAT CEILING, and the one place a stored figure is not
 * reported in full. A return may report at most the tax its own
 * `refunds.totalAmount` contains at the sale's rate — that is rule 42 summed
 * over the lines, not a policy of ours. A refund CAN store more: the POS builds
 * a partial refund's line at the item's NET `lineTotal` and requires the tender
 * to equal it, so a VAT-exclusive tenant refunding one 100.00 item pays back
 * 100.00 while the refund domain attributes that item's whole 14.00 of VAT to
 * it. 100.00 of money contains 12.28 of VAT, not 14.00, so 12.28 is what this
 * document reports and `taxTotals` (which ETA DEFINES as
 * "taxTotals <taxType> = Sum (itemData[*].taxableItems[taxType=].amount)")
 * follows the lines. Reporting the stored 14.00 would claim credit for tax the
 * customer was never handed back AND be rejected outright; under-reversing is
 * the safe side of the same trade `refund-vat.ts` documents for the service
 * charge. The gap is fully derivable from the two stored figures and is zero
 * for every refund whose money and VAT agree.
 *
 * ZERO AND LEGACY REFUNDS. `refunds.vatAmount` of `0.00` — a non-VAT order —
 * and the legacy `'0'` written before the column existed both emit NO
 * `taxableItems` and NO `taxTotals`: round 1's omission rule, and rule 42's
 * direct consequence, since a zero amount at a non-zero rate is arithmetically
 * false.
 */
export function buildReturnReceipt(input: FiscalRefundInput): FiscalDocument {
  const { refund, lines: refundLines, items, taxCodes, order } = input;
  if (refundLines.length === 0) throw new EmptyReturnReceiptError(refund.id);
  const codes = taxCodeIndex(taxCodes);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const rate = assertDecimal(order.vatRateSnapshot, "orders.vatRateSnapshot");
  const headerVat = assertDecimal(refund.vatAmount, "refunds.vatAmount");
  const noVat = isZeroDecimal(headerVat);

  const drafts: ReturnDraft[] = refundLines.map((refundLine) => {
    const item = itemsById.get(refundLine.orderItemId);
    if (!item) throw new RefundLineOrphanError(refundLine.id, refundLine.orderItemId);
    const code = requireTaxCode(codes, item.productId);
    if (compareDecimal(assertDecimal(refundLine.vatAmount, "refund_lines.vatAmount"), "0") < 0) {
      throw new IrreconcilableOrderError(
        refund.orderId,
        `refund ${refund.id} stores a negative VAT of ${refundLine.vatAmount} on the line returning ${refundLine.amount}; ` +
          "a return may not claim back tax that was never charged",
      );
    }
    return {
      line: {
        itemCode: code.itemCode,
        internalCode: item.productId,
        codeSource: code.codeSource,
        taxType: code.taxType,
        taxSubType: code.taxSubType,
        unitType: code.unitType,
        description: item.nameEn,
        quantity: refundLine.quantity,
        discountAmount: "0.00",
      },
      amount: assertDecimal(refundLine.amount, "refund_lines.amount"),
      storedVat: refundLine.vatAmount,
    };
  });

  // Net or gross? See NET VS GROSS LINE AMOUNTS above: the order's own
  // convention decides, but only where it still fits inside the money the
  // refund paid out.
  const returnedByLines = sumDecimal("refund line amounts", drafts.map((draft) => draft.amount));
  const withTaxOnTop = addDecimal("refund line amounts", returnedByLines, headerVat);
  const basis: ReturnAmountBasis =
    !noVat && vatMode(order) === "exclusive" && compareDecimal(withTaxOnTop, refund.totalAmount) <= 0 ? "net" : "gross";

  // The money the refund returned that no `refund_lines` row accounts for — the
  // service charge, which is order-level and so has no order_items row to hang
  // a refund line on. Negative means the lines claim more than the refund
  // itself recorded, which no attribution can fix and ETA's totalAmount
  // equation would reject anyway.
  const feeMoney = subtractDecimal(
    "service charge returned", refund.totalAmount, basis === "net" ? withTaxOnTop : returnedByLines);
  if (compareDecimal(feeMoney, "0") < 0) {
    throw new IrreconcilableOrderError(
      refund.orderId,
      `refund ${refund.id} records a total of ${refund.totalAmount} but its lines account for ${
        basis === "net" ? withTaxOnTop : returnedByLines}; ` +
        "a return receipt's totalAmount is the sum of its line totals, so the stored line amounts cannot exceed it",
    );
  }

  if (compareDecimal(feeMoney, "0") > 0) {
    const config = input.feeLines?.serviceCharge;
    if (!config) throw new FeeLineConfigMissingError("serviceCharge", feeMoney);
    drafts.push({
      line: {
        itemCode: config.itemCode,
        internalCode: config.internalCode,
        codeSource: config.codeSource,
        taxType: config.taxType,
        taxSubType: config.taxSubType,
        unitType: config.unitType,
        description: config.description,
        quantity: 1,
        discountAmount: "0.00",
      },
      amount: feeMoney,
      // It stores no VAT of its own: what it reports is whatever the product
      // lines' rule-42 caps handed back — which is exactly the charge's share.
      storedVat: "0.00",
    });
  }

  const { vats } = noVat
    ? { vats: drafts.map(() => "0.00") }
    : attributeReturnVat(drafts, headerVat, rate, basis);

  const lines: FiscalDocLine[] = drafts.map((draft, index) => {
    const vat = vats[index];
    // netSale is tax-EXCLUSIVE by ETA's definition, so a gross amount has its
    // reversed tax taken back out and a net one passes through untouched (F9)
    // — the same rule `buildReceipt` applies to a sale line. Either way
    // `total = netSale + t1` lands back on the money the line accounts for,
    // which is what keeps `totalAmount = Sum(itemData.total)` equal to
    // `refunds.totalAmount`.
    const netSale = basis === "net" ? draft.amount : subtractDecimal("netSale", draft.amount, vat);
    return {
      ...draft.line,
      // Main Calculations: "totalSale = quantity * unitPrice", and a return
      // carries no discounts, so totalSale is netSale.
      unitPrice: divideDecimal("unitPrice", netSale, String(draft.line.quantity), UNIT_PRICE_SCALE),
      taxes: isZeroDecimal(vat)
        ? []
        : [{ taxType: draft.line.taxType, taxSubType: draft.line.taxSubType, rate, amount: vat }],
      lineTotal: netSale,
    };
  });

  const taxed = drafts.find((_, index) => !isZeroDecimal(vats[index]));
  const reported = sumDecimal("return VAT", vats);
  return {
    docType: "return_receipt",
    uuid: null,
    previousUuid: input.previousUuid,
    referenceUuid: input.parentUuid,
    referenceOldUuid: null,
    buyer: { type: "P" },
    lines,
    subtotal: sumDecimal("subtotal", lines.map((line) => line.lineTotal)),
    discountTotal: "0.00",
    feesTotal: feeMoney,
    // ETA defines this as the sum of the lines' taxableItems, and
    // `assertTotalsReconcile` holds us to that. It IS `refunds.vatAmount` for
    // every refund whose money and VAT agree — see THE DOCUMENT'S VAT CEILING.
    taxTotals: isZeroDecimal(reported)
      ? []
      : [{ taxType: taxed?.line.taxType ?? DEFAULT_TAX_TYPE, taxSubType: taxed?.line.taxSubType ?? null, rate, amount: reported }],
    total: refund.totalAmount,
    // A refund reverses the sale's tender; ServeOS records the outgoing
    // method on `refund_payments`, which this input does not carry, so the
    // conservative "Others" code applies until it does.
    paymentMethodCode: "O",
    currency: CURRENCY,
    issuedAt: toEtaUtc(refund.createdAt),
  };
}
