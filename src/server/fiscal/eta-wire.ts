import type { FiscalDocument, FiscalDocLine, FiscalTaxAmount } from "./provider";
import { addDecimal, assertDecimal, isZeroDecimal } from "./decimal";

/**
 * `FiscalDocument` -> ETA receipt v1.2 JSON.
 *
 * Field names, cardinality and constant values below come from the ETA SDK
 * pages, not from memory:
 *   Receipt v1.2        https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/
 *   Return Receipt v1.2 https://sdk.invoicing.eta.gov.eg/documents/return-receipt-v1-2/
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

/**
 * A decimal that must reach ETA as an unquoted JSON number while keeping its
 * exact literal text.
 *
 * ETA's serialization takes "all property values ... without any processing,
 * just like those are in the input document", and their own worked example
 * serializes `10.50` as `"10.50"` — a JS `number` cannot carry that trailing
 * zero, and `Number("115.00")` is `115`. So every money value travels as its
 * original `money(n)` characters and is only unquoted at emit time.
 */
export class WireDecimal {
  constructor(readonly literal: string) {}
}

/** Wraps a `money(n)` string as a wire decimal, rejecting anything that is not
 *  a plain decimal numeral. */
export function dec(literal: string, field = "amount"): WireDecimal {
  return new WireDecimal(assertDecimal(literal, field));
}

/** ETA rejects a fee it has nowhere to put; see `FEES_MUST_BE_ZERO`. */
export class UnrepresentableFeesError extends Error {
  constructor(readonly feesTotal: string) {
    super(
      `fiscal: receipt v1.2 feesAmount "accepts only zero values" but this document carries ${feesTotal} of service charge + delivery fee. ` +
        "ETA has no receipt-level slot for it — the fees must be issued as their own itemData lines (deferred to the fiscal config work).",
    );
    this.name = "UnrepresentableFeesError";
  }
}

/** Structural constants of the format itself — not tenant data. */
const TYPE_VERSION = "1.2";
const RECEIPT_TYPE_SALE = "s";
const RECEIPT_TYPE_RETURN = "r";
/** Receipt v1.2: "feesAmount and adjustment fields are reserved for future
 *  use, both accept only zero values". */
const FEES_MUST_BE_ZERO = dec("0", "feesAmount");

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
 * This is per-DOCUMENT context, not per-tenant: `receiptNumber` and
 * `paymentMethodCode` vary by receipt.
 *
 * Nothing here is defaulted to a literal — a wrong RIN, branch or activity
 * code is a rejected (or misfiled) fiscal document, so each one is the
 * caller's explicit decision. Task 3b resolves them from
 * `eta_tenant_config` / `pos_devices` / branch settings.
 */
export type WireContext = {
  /** `seller.rin` — the taxpayer registration number. */
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
  /** `header.receiptNumber` — Mandatory, "unique per branch within the same
   *  submission". `orders.orderNumber` is the natural source. */
  receiptNumber: string;
  /** `paymentMethod` — Mandatory, from ETA's Payment Methods table
   *  (C cash, V visa, CC/VC with contractor, VO vouchers, PR promotion,
   *  GC gift card, P points, O others). ServeOS's `payment_method` enum
   *  (cash/instapay/vodafone_cash/mobile_wallet) has no published mapping,
   *  so the caller decides. */
  paymentMethodCode: string;
  /** `seller.syndicateLicenseNumber` — Optional; "In case it is a company,
   *  the value should be 'C'". */
  syndicateLicenseNumber?: string;
  /** `description` on the emitted discount objects, which ETA marks Mandatory.
   *  `orders.discountReason` is the natural source. */
  discountDescription?: string;
};

const DEFAULT_DISCOUNT_DESCRIPTION = "Discount";

/** ETA's `itemType`: "Must be GS1 or EGS for this version". */
function itemType(codeSource: FiscalDocLine["codeSource"]): string {
  return codeSource.toUpperCase();
}

/** `taxableItems[]` — `subType` is Mandatory, so a line tax without one is a
 *  data error rather than something to paper over. */
function toTaxableItem(tax: FiscalTaxAmount, index: number): Record<string, unknown> {
  if (tax.taxSubType === null) {
    throw new Error(`fiscal: line tax #${index} (${tax.taxType}) has no taxSubType, which receipt v1.2 marks Mandatory on taxableItems`);
  }
  return {
    taxType: tax.taxType,
    subType: tax.taxSubType,
    amount: dec(tax.amount, "taxableItems.amount"),
    rate: dec(tax.rate, "taxableItems.rate"),
  };
}

/**
 * One `itemData` element.
 *
 * `netSale` is the line after its own discount, which is exactly what
 * `order_items.lineTotal` stores; `totalSale` is "considering quantity and
 * unit price", i.e. before that discount, so it is the one derived value here
 * (an exact decimal sum, not a float multiply). `total` is the line after
 * taxes — with no per-line tax stored it equals `netSale`.
 *
 * `internalCode` is Mandatory and `FiscalDocLine` carries no internal
 * identifier, so the item code doubles as it ("can be used to simplify
 * references back to existing solution").
 */
function toItemData(line: FiscalDocLine, ctx: WireContext): Record<string, unknown> {
  const netSale = assertDecimal(line.lineTotal, "lineTotal");
  const discount = assertDecimal(line.discountAmount, "line discountAmount");
  const totalSale = addDecimal("totalSale", netSale, discount);
  const lineTax = line.taxes.map(toTaxableItem);
  const total = addDecimal("line total", netSale, ...line.taxes.map((tax) => tax.amount));

  return {
    internalCode: line.itemCode,
    description: line.description,
    itemType: itemType(line.codeSource),
    itemCode: line.itemCode,
    unitType: line.unitType,
    quantity: line.quantity,
    unitPrice: dec(line.unitPrice, "unitPrice"),
    netSale: dec(netSale, "netSale"),
    totalSale: dec(totalSale, "totalSale"),
    total: dec(total, "line total"),
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
 * Builds the receipt v1.2 / return receipt v1.2 JSON for one document.
 *
 * `header.uuid` is emitted as an empty string: the uuid is the hash of this
 * very document, so `finalizeReceipt` (./serialize) computes it from the
 * blank-uuid form and writes it back into this same key, in place.
 *
 * TOTALS RECONCILIATION — known gap. ETA defines
 * "totalAmount = sum of all receipt line total - total extraDiscountAmount"
 * and validates it. `totalAmount` here is `orders.total` verbatim (F9), which
 * also includes VAT, service charge and delivery. Because ServeOS stores VAT
 * only per order, the emitted lines carry no `taxableItems`, so the sum of
 * line totals is VAT-exclusive and will not reconcile while VAT is non-zero.
 * Closing that needs a per-line VAT allocation decided at the ordering layer
 * — it is not something this mapper may invent.
 */
export function toWireReceipt(doc: FiscalDocument, ctx: WireContext): Record<string, unknown> {
  if (!isZeroDecimal(doc.feesTotal)) throw new UnrepresentableFeesError(doc.feesTotal);

  const isReturn = doc.docType === "return_receipt";
  if (isReturn && !doc.referenceUuid) {
    throw new Error("fiscal: a return receipt requires referenceUUID — the uuid of the original sale receipt (Mandatory in v1.2)");
  }

  const lines = doc.lines.map((line) => toItemData(line, ctx));
  const netAmount = addDecimal("netAmount", ...doc.lines.map((line) => line.lineTotal));
  const totalSales = addDecimal("totalSales", ...doc.lines.map((line) => addDecimal("totalSale", line.lineTotal, line.discountAmount)));
  const lineDiscounts = addDecimal("totalCommercialDiscount", ...doc.lines.map((line) => line.discountAmount));
  const orderDiscount = assertDecimal(doc.discountTotal, "discountTotal");

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
    // An order-level discount is ETA's "extra receipt level discount" — the
    // one deducted after the line totals in their totalAmount definition.
    ...(isZeroDecimal(orderDiscount)
      ? {}
      : {
          extraReceiptDiscountData: [
            { amount: dec(orderDiscount, "extraReceiptDiscountData.amount"), description: ctx.discountDescription ?? DEFAULT_DISCOUNT_DESCRIPTION },
          ],
        }),
    netAmount: dec(netAmount, "netAmount"),
    feesAmount: FEES_MUST_BE_ZERO,
    totalAmount: dec(doc.total, "totalAmount"),
    ...(doc.taxTotals.length > 0
      ? { taxTotals: doc.taxTotals.map((tax) => ({ taxType: tax.taxType, amount: dec(tax.amount, "taxTotals.amount") })) }
      : {}),
    paymentMethod: ctx.paymentMethodCode,
  };
}
