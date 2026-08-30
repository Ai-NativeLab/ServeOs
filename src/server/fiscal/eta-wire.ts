import type { FiscalDocument, FiscalDocLine, FiscalTaxAmount, FinalizedFiscalDocument } from "./provider";
import {
  addDecimal, sumDecimal, subtractDecimal, multiplyDecimal, absDecimal,
  compareDecimal, assertDecimal, isZeroDecimal, dec,
} from "./decimal";
import { computeReceiptUuid, buildQrUrl } from "./serialize";
import {
  EtaTotalsMismatchError, UnsupportedTaxTypeError, BuyerIdRequiredError,
  MissingTaxSubTypeError, MissingReferenceUuidError,
} from "./errors";

/**
 * `FiscalDocument` -> ETA receipt v1.2 JSON.
 *
 * Field names, cardinality and constant values below come from the ETA SDK
 * pages, not from memory:
 *   Receipt v1.2        https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/
 *   Return Receipt v1.2 https://sdk.invoicing.eta.gov.eg/documents/return-receipt-v1-2/
 *   Main Calculations   https://sdk.invoicing.eta.gov.eg/main-calculations/
 *   Sample batch JSON   https://sdk.invoicing.eta.gov.eg/files/BatchReceipt.json
 * The document pages caveat that "actual attribute naming could be different
 * for JSON structure", so the exact JSON spelling and the fact that
 * `taxTotals` is an ARRAY (the page's table calls it a structure) are taken
 * from ETA's own sample batch.
 *
 * PROPERTY ORDER IS LOAD-BEARING. The canonical serialization walks
 * properties in document order and never sorts, so the order in which this
 * module emits keys IS the hash input. `stringifyWire` emits the same object
 * in the same order, which is what keeps the transmitted bytes and the hashed
 * text in agreement.
 */

/** Tax types whose amounts ETA ADDS in the line-total equation. T4 is absent
 *  on purpose — it subtracts; see `UnsupportedTaxTypeError`. */
const ADDITIVE_TAX_TYPES = new Set([
  "T1", "T2", "T3", "T5", "T6", "T7", "T8", "T9", "T10",
  "T11", "T12", "T13", "T14", "T15", "T16", "T17", "T18", "T19", "T20",
]);

/** Structural constants of the format itself — not tenant data. */
const TYPE_VERSION = "1.2";
const RECEIPT_TYPE_SALE = "s";
const RECEIPT_TYPE_RETURN = "r";
/**
 * Receipt v1.2: "feesAmount and adjustment fields are reserved for future
 * use, both accept only zero values". ServeOS's service charge and delivery
 * fee therefore never land here — the builder issues them as their own
 * `itemData` lines, and these two slots are hard-wired to zero.
 */
const FEES_AMOUNT = dec("0.00", "feesAmount");
const ADJUSTMENT = dec("0.00", "adjustment");

/** `seller.branchAddress` — Mandatory, and ServeOS's `branches.address` is a
 *  single free-text line, so every component has to be supplied. */
export type WireBranchAddress = {
  /** `country` — ISO-3166-2, "Must be EG for internal business issuers". */
  country: string;
  /** `governate` */
  governate: string;
  /** `regionCity` */
  regionCity: string;
  /** `street` */
  street: string;
  /** `buildingNumber` */
  buildingNumber: string;
  /** `postalCode` — Optional. */
  postalCode?: string;
  /** `floor` — Optional. */
  floor?: string;
  /** `room` — Optional. */
  room?: string;
  /** `landmark` — Optional. */
  landmark?: string;
  /** `additionalInformation` — Optional. */
  additionalInformation?: string;
};

/**
 * Everything receipt v1.2 requires that a `FiscalDocument` does not carry.
 *
 * Nothing here is defaulted to a literal — a wrong RIN, branch or activity
 * code is a rejected (or misfiled) fiscal document, so each one is the
 * caller's explicit decision. Task 3b resolves them from
 * `eta_tenant_config` / `pos_devices` / branch settings.
 */
export type WireContext = {
  /**
   * `seller.rin` — the taxpayer registration number.
   *
   * Main Calculations requires exactly 9 digits here (and 9 for a type-B
   * `buyer.id`, 14 for a type-P national ID). Those shapes are NOT validated
   * in this pure layer: the values come from tenant configuration, so Task
   * 3b/6 validates them once at config-save time rather than on every
   * receipt.
   */
  rin: string;
  /** `seller.companyTradeName` — the registered company name. */
  sellerName: string;
  /** `seller.branchCode` — the branch code as registered with ETA. */
  branchCode: string;
  /** `seller.branchAddress` — Mandatory nested structure. */
  branchAddress: WireBranchAddress;
  /** `seller.deviceSerialNumber` — the POS serial registered at pos.eta.gov.eg. */
  deviceSerial: string;
  /** `seller.activityCode` — Mandatory; from ETA's Activity Codes table.
   *  ServeOS stores no activity code, so the caller supplies it. */
  activityCode: string;
  /**
   * `header.receiptNumber` — Mandatory, String(50), "unique per branch within
   * the same submission". Supplied by the caller, never derived here: Task 5's
   * worker passes `orders.orderNumber`, which is sequential per tenant.
   *
   * OPEN FOR TASK 5: ETA scopes uniqueness to the branch within a submission,
   * while the uuid chain is scoped per DEVICE. Two devices in one branch
   * submitting concurrently could therefore reuse a number unless Task 5
   * either scopes the counter per branch or qualifies it with the device.
   */
  receiptNumber: string;
  /** `seller.syndicateLicenseNumber` — Optional; "In case it is a company,
   *  the value should be 'C'". */
  syndicateLicenseNumber?: string;
  /** `description` on the emitted discount objects, which ETA marks Mandatory.
   *  `orders.discountReason` is the natural source. */
  discountDescription?: string;
  /** The amount at or above which a natural-person buyer must be identified.
   *  Defaults to ETA's 150,000 EGP for v1.2; see `DEFAULT_BUYER_ID_THRESHOLD`. */
  buyerIdThreshold?: string;
};

const DEFAULT_DISCOUNT_DESCRIPTION = "Discount";

/** ETA's configured buyer-identification amount: 150,000 EGP for receipt v1.2
 *  and newer (50,000 for 1.0-1.1), per the Receipt Issuance FAQ's National ID
 *  Validator. Overridable because ETA can reconfigure it. */
const DEFAULT_BUYER_ID_THRESHOLD = "150000";

/** ETA's own rounding allowance on every published calculation is +/- 0.5.
 *  This guard is far tighter: `unitPrice` is derived from `totalSale` at 5
 *  decimals, so the only legitimate gap is that derivation's own rounding,
 *  bounded by quantity * 0.00001. Anything larger is a real mapping bug.
 *  (Scale note: past a quantity of ~100,000 that bound itself exceeds ETA's
 *  own +/- 0.5 allowance — unreachable for integer F&B quantities, so it is
 *  documented rather than guarded.) */
const UNIT_PRICE_ROUNDING_BOUND = "0.00001";

/** ETA's `itemType`: "Must be GS1 or EGS for this version". */
function itemType(codeSource: FiscalDocLine["codeSource"]): string {
  return codeSource.toUpperCase();
}

/** `taxableItems[]` — `subType` is Mandatory, so a line tax without one is a
 *  data error rather than something to paper over. */
function toTaxableItem(tax: FiscalTaxAmount, index: number): Record<string, unknown> {
  if (!ADDITIVE_TAX_TYPES.has(tax.taxType)) throw new UnsupportedTaxTypeError(tax.taxType);
  if (tax.taxSubType === null) throw new MissingTaxSubTypeError(tax.taxType, index);
  return {
    taxType: tax.taxType,
    subType: tax.taxSubType,
    amount: dec(tax.amount, "taxableItems.amount"),
    rate: dec(tax.rate, "taxableItems.rate"),
  };
}

/** The line's `total` per Main Calculations: `netSale` plus its taxes (only
 *  T1 VAT is in play here; T4 would subtract, T5-T20 add). */
function lineTotal(line: FiscalDocLine): string {
  return addDecimal("line total", line.lineTotal, ...line.taxes.map((tax) => tax.amount));
}

/**
 * One `itemData` element, satisfying Main Calculations:
 *   totalSale = quantity * unitPrice
 *   netSale   = totalSale - Sum(commercialDiscountData.amount)
 *   total     = netSale + t1Amount (+ other tax types)
 *
 * `FiscalDocLine.lineTotal` already holds the tax-exclusive `netSale`, so
 * `totalSale` is simply that plus the line's discounts.
 */
function toItemData(line: FiscalDocLine, ctx: WireContext): Record<string, unknown> {
  const netSale = assertDecimal(line.lineTotal, "lineTotal");
  const discount = assertDecimal(line.discountAmount, "line discountAmount");
  const totalSale = addDecimal("totalSale", netSale, discount);
  const lineTax = line.taxes.map(toTaxableItem);

  return {
    // Mandatory; the product id for a sale line, the configured code for a fee line.
    internalCode: line.internalCode,
    description: line.description,
    itemType: itemType(line.codeSource),
    itemCode: line.itemCode,
    unitType: line.unitType,
    quantity: line.quantity,
    unitPrice: dec(line.unitPrice, "unitPrice"),
    netSale: dec(netSale, "netSale"),
    totalSale: dec(totalSale, "totalSale"),
    total: dec(lineTotal(line), "line total"),
    ...(isZeroDecimal(discount)
      ? {}
      : {
          commercialDiscountData: [
            { amount: dec(discount, "commercialDiscountData.amount"), description: ctx.discountDescription ?? DEFAULT_DISCOUNT_DESCRIPTION },
          ],
        }),
    ...(lineTax.length > 0 ? { taxableItems: lineTax } : {}),
  };
}

/**
 * Guards the two equations ETA publishes and validates, on the document we
 * are actually about to emit:
 *
 *   totalAmount = Sum(itemData.total) - Sum(extraReceiptDiscountData.amount) + adjustment
 *   taxTotals<taxType> = Sum(itemData.taxableItems[taxType].amount)
 */
function assertTotalsReconcile(doc: FiscalDocument, extraDiscount: string): void {
  for (const [index, line] of doc.lines.entries()) {
    // A line's classification is refused even when no tax was allocated to
    // it, so a T4-coded product can never reach a document at all.
    if (!ADDITIVE_TAX_TYPES.has(line.taxType)) throw new UnsupportedTaxTypeError(line.taxType);

    // "itemData[*].totalSale = itemData[*].quantity * itemData[*].unitPrice".
    const quantity = String(line.quantity);
    const totalSale = addDecimal("totalSale", line.lineTotal, line.discountAmount);
    const extended = multiplyDecimal("totalSale", quantity, line.unitPrice);
    const drift = absDecimal(subtractDecimal("totalSale", extended, totalSale));
    const bound = multiplyDecimal("totalSale bound", quantity, UNIT_PRICE_ROUNDING_BOUND);
    if (compareDecimal(drift, bound) > 0) {
      throw new EtaTotalsMismatchError(totalSale, extended, `itemData[${index}].totalSale = quantity * unitPrice`);
    }
  }

  const summedLines = sumDecimal("line totals", doc.lines.map(lineTotal));
  const computed = subtractDecimal("totalAmount", summedLines, extraDiscount);
  if (compareDecimal(computed, doc.total) !== 0) {
    throw new EtaTotalsMismatchError(doc.total, computed, "totalAmount = Sum(itemData.total) - Sum(extraReceiptDiscountData.amount)");
  }

  for (const total of doc.taxTotals) {
    const summedTax = sumDecimal(
      "taxTotals",
      doc.lines.flatMap((line) => line.taxes.filter((tax) => tax.taxType === total.taxType).map((tax) => tax.amount)),
    );
    if (compareDecimal(summedTax, total.amount) !== 0) {
      throw new EtaTotalsMismatchError(total.amount, summedTax, `taxTotals[${total.taxType}] = Sum(itemData.taxableItems[${total.taxType}].amount)`);
    }
  }
}

/**
 * Receipt v1.2's buyer rule: id + name are "Optional in all cases except when
 * 1.type is B 2.type is P and totalAmount equals to or greater than a
 * configured value (150000 EGP)".
 */
function assertBuyerIdentified(doc: FiscalDocument, threshold: string): void {
  const buyer = doc.buyer;
  if (!buyer) return;

  // BOTH fields are Mandatory together, so an id alone is not identification —
  // a `{ type: "B", id }` buyer with no name would be rejected by ETA.
  const missing = ["id" as const, "name" as const].filter((field) => !buyer[field]);
  if (missing.length === 0) return;

  if (buyer.type === "B") throw new BuyerIdRequiredError(buyer.type, doc.total, "0", missing);
  if (buyer.type === "P" && compareDecimal(doc.total, threshold) >= 0) {
    throw new BuyerIdRequiredError(buyer.type, doc.total, threshold, missing);
  }
}

/**
 * Builds the receipt v1.2 / return receipt v1.2 JSON for one document.
 *
 * `header.uuid` is emitted as an empty string: the uuid is the hash of this
 * very document, so `finalizeReceipt` (./serialize) computes it from the
 * blank-uuid form and writes it back into this same key, in place.
 */
export function toWireReceipt(doc: FiscalDocument, ctx: WireContext): Record<string, unknown> {
  const isReturn = doc.docType === "return_receipt";
  if (isReturn && !doc.referenceUuid) throw new MissingReferenceUuidError();

  assertBuyerIdentified(doc, ctx.buyerIdThreshold ?? DEFAULT_BUYER_ID_THRESHOLD);

  const extraDiscount = assertDecimal(doc.discountTotal, "discountTotal");
  assertTotalsReconcile(doc, extraDiscount);

  const lines = doc.lines.map((line) => toItemData(line, ctx));
  const netAmount = sumDecimal("netAmount", doc.lines.map((line) => line.lineTotal));
  const totalSales = sumDecimal("totalSales", doc.lines.map((line) => addDecimal("totalSale", line.lineTotal, line.discountAmount)));
  const lineDiscounts = sumDecimal("totalCommercialDiscount", doc.lines.map((line) => line.discountAmount));

  return {
    header: {
      dateTimeIssued: doc.issuedAt,
      receiptNumber: ctx.receiptNumber,
      // Blank until finalizeReceipt hashes this document; the key must exist
      // here so the hashed text and the transmitted text agree.
      uuid: "",
      // "empty string value is accepted only if this is the first receipt
      // issued from this POS" — the chain head, straight from the device row.
      previousUUID: doc.previousUuid ?? "",
      ...(isReturn ? { referenceUUID: doc.referenceUuid } : {}),
      ...(doc.referenceOldUuid ? { referenceOldUUID: doc.referenceOldUuid } : {}),
      currency: doc.currency,
    },
    documentType: {
      receiptType: isReturn ? RECEIPT_TYPE_RETURN : RECEIPT_TYPE_SALE,
      typeVersion: TYPE_VERSION,
    },
    seller: {
      rin: ctx.rin,
      companyTradeName: ctx.sellerName,
      branchCode: ctx.branchCode,
      branchAddress: { ...ctx.branchAddress },
      deviceSerialNumber: ctx.deviceSerial,
      ...(ctx.syndicateLicenseNumber ? { syndicateLicenseNumber: ctx.syndicateLicenseNumber } : {}),
      activityCode: ctx.activityCode,
    },
    buyer: {
      type: doc.buyer?.type ?? "P",
      ...(doc.buyer?.id ? { id: doc.buyer.id } : {}),
      ...(doc.buyer?.name ? { name: doc.buyer.name } : {}),
    },
    itemData: lines,
    totalSales: dec(totalSales, "totalSales"),
    ...(isZeroDecimal(lineDiscounts) ? {} : { totalCommercialDiscount: dec(lineDiscounts, "totalCommercialDiscount") }),
    // A receipt-level discount is one ETA subtracts AFTER tax. ServeOS
    // discounts before VAT, so the builder pushes its order discount onto the
    // lines instead and this stays empty — see buildLineDrafts.
    ...(isZeroDecimal(extraDiscount)
      ? {}
      : {
          extraReceiptDiscountData: [
            { amount: dec(extraDiscount, "extraReceiptDiscountData.amount"), description: ctx.discountDescription ?? DEFAULT_DISCOUNT_DESCRIPTION },
          ],
        }),
    netAmount: dec(netAmount, "netAmount"),
    feesAmount: FEES_AMOUNT,
    totalAmount: dec(doc.total, "totalAmount"),
    ...(doc.taxTotals.length > 0
      ? { taxTotals: doc.taxTotals.map((tax) => ({ taxType: tax.taxType, amount: dec(tax.amount, "taxTotals.amount") })) }
      : {}),
    paymentMethod: doc.paymentMethodCode,
    adjustment: ADJUSTMENT,
  };
}

/**
 * Wire document + uuid + QR url for one fiscal document, in the order the
 * chain requires: map to v1.2 JSON (carrying previousUUID / referenceUUID /
 * referenceOldUUID), hash the blank-uuid form, write the uuid back, then build
 * the QR from that same uuid. Pure — same inputs, same uuid, every time.
 *
 * `opts.portalBase` is the eInvoicing portal the QR url points at. Task 3b
 * derives it from `cfg.environment` through a single preprod/prod constant
 * map; it is deliberately NOT on `EtaConfig`, which carries credentials
 * rather than presentation.
 */
export function finalizeReceipt(
  doc: FiscalDocument,
  ctx: WireContext,
  opts: { portalBase: string },
): FinalizedFiscalDocument {
  const wire = toWireReceipt(doc, ctx);
  const uuid = computeReceiptUuid(wire);

  // `toWireReceipt` just built this object and nothing else holds a reference
  // to it yet, so mutating it here is unobservable — and it keeps `uuid` at
  // the exact key position the hash was taken over, which rebuilding the
  // object would have to reproduce by hand.
  const header = wire.header as Record<string, unknown>;
  header.uuid = uuid;

  return {
    docType: doc.docType,
    wire,
    uuid,
    qrUrl: buildQrUrl({ portalBase: opts.portalBase, uuid, dateUtc: doc.issuedAt, total: doc.total, rin: ctx.rin }),
  };
}
