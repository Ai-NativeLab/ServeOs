import type { FiscalDocument, FiscalDocLine, FiscalTaxAmount, FiscalAddress } from "./provider";
import {
  addDecimal, sumDecimal, subtractDecimal, compareDecimal, assertDecimal, isZeroDecimal, dec,
} from "./decimal";
import {
  lineTotal, foldTaxTotalsByType, assertLineIsWellFormed, assertTaxTotalsMatchLines,
} from "./eta-wire";
import {
  EtaTotalsMismatchError, MissingTaxSubTypeError, BuyerIdRequiredError,
} from "./errors";

/**
 * `FiscalDocument` -> ETA invoice v1.0 (or v0.9) JSON.
 *
 *   Invoice v1.0       https://sdk.invoicing.eta.gov.eg/documents/invoice-v1-0/
 *   Invoice v0.9       https://sdk.invoicing.eta.gov.eg/documents/invoice-v0-9/
 *   Main Calculations  https://sdk.invoicing.eta.gov.eg/main-calculations/
 *   Submit Documents   https://sdk.invoicing.eta.gov.eg/einvoicingapi/01-submit-documents/
 *   Signature creation https://sdk.invoicing.eta.gov.eg/signature-creation/
 *   Sample invoice     https://sdk.invoicing.eta.gov.eg/files/one-doc.json      (unsigned)
 *                      https://sdk.invoicing.eta.gov.eg/files/one-doc-I.json    (signed)
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE FROM `./eta-wire` RATHER THAN A BRANCH IN IT.
 *
 * The two document families share their ARITHMETIC and almost none of their
 * SHAPE. Every equation is imported from `./eta-wire` and reused verbatim —
 * `assertLineIsWellFormed` (rules 11 and 42), `assertTaxTotalsMatchLines`
 * (rule 26), `lineTotal`, `foldTaxTotalsByType` — because Main Calculations is
 * one document that numbers its rules once and ETA re-derives them on receipt of
 * either family. What differs is every field name and the whole envelope: an
 * invoice has `invoiceLines` where a receipt has `itemData`, `netTotal` where it
 * has `netSale`, a nested `unitValue` structure where it has a scalar
 * `unitPrice`, an `issuer`/`receiver` pair where it has `seller`/`buyer`, a
 * document-level `signatures` array the receipt family does not carry at all,
 * and no `header` object, no `previousUUID`, no `paymentMethod` and no
 * `adjustment`. Folding that into `toWireReceipt` would have produced a mapper
 * whose every line was inside a conditional — the shape is the module.
 *
 * ---------------------------------------------------------------------------
 * PROPERTY ORDER IS LOAD-BEARING, and this module's order is ETA's OWN.
 *
 * The canonical serialization walks properties in document order and never
 * sorts, so the order emitted here IS the text that gets hashed and signed
 * ("Create canonical version of the XML or JSON as per algorithm described";
 * "Apply sha256 hash on the byte array created from canonical version"). Every
 * section below is ordered to match ETA's own published sample invoice,
 * `files/one-doc.json` — which this repository already carries as
 * `__fixtures__/one-doc.json`, and which `serialize.test.ts` already proves
 * `canonicalSerialize` reproduces byte for byte against ETA's published
 * `one-doc-serialized.json.txt`. That makes the fixture a genuine structural
 * oracle rather than a convenience: `build-invoice.test.ts` asserts this
 * mapper's key order section by section against it.
 *
 * TWO PLACES ETA'S PAGE AND ETA'S SAMPLE DISAGREE, and how each is resolved:
 *
 *   `internalID` vs `internalId`, and `branchID` vs `branchId`. The page's
 *   tables spell both with a lower-case `d`; both samples spell them with a
 *   capital. Round 1 already settled this class — the document pages caveat that
 *   "actual attribute naming could be different for JSON structure", so ETA's
 *   own working JSON wins on SPELLING. Capitals, matching the samples.
 *
 *   `documentType`: the page says "Must be `i` for invoice", both samples carry
 *   `"I"`, and Get Submission reports `typeName` back in lower case. This one is
 *   a VALUE, not a name, so the page's rule is the more direct evidence — but a
 *   value is also the thing a working sample proves. `"I"` is emitted, because
 *   the samples are complete documents ETA published as submittable and the
 *   lower-case `i` appears only in prose. It is a ONE-CHARACTER flip if preprod
 *   disagrees, and it is listed as such in the addendum's VERIFY set.
 */

/** The document type code — see the TWO PLACES note above. */
const DOCUMENT_TYPE_INVOICE = "I";

/**
 * The two invoice document versions ETA publishes, and the only reason to pick
 * between them.
 *
 * v0.9: "v0.9 of the Invoice document type structure is maintained as v1.0, the
 * only difference is that signature validation is disabled on this version."
 * Same structure, same fields, same equations — so this is a version STRING and
 * nothing else in this mapper branches on it. What it buys is the ability to
 * file a legally-required document while the taxpayer's ITIDA e-seal is not yet
 * in ServeOS's hands, which is the situation every tenant is in before
 * registration completes.
 *
 * VERIFY-GATED. That sentence is the whole of ETA's published guidance on v0.9;
 * it does not say whether v0.9 is still ACCEPTED in production or has been
 * retired in favour of mandatory signing, and the SDK's documents index carries
 * no deprecation column. Submitting one against preprod is the only way to find
 * out, and it is an open item in addendum §6 rather than an assumption baked in
 * here.
 */
export type InvoiceDocumentTypeVersion = "0.9" | "1.0";

/** ETA's `itemType`: "Must be GS1 or EGS for this version" — the same rule and
 *  the same mapping as the receipt family's. (ETA's own sample predates the
 *  rule and carries `GPC`; the page's constraint is what this version states.) */
function itemType(codeSource: FiscalDocLine["codeSource"]): string {
  return codeSource.toUpperCase();
}

/**
 * Everything invoice v1.0 requires that a `FiscalDocument` does not carry — the
 * issuer half, plus the two per-document references.
 *
 * The same principle as `WireContext` (./eta-wire): nothing is defaulted to a
 * literal, because a wrong RIN, branch or activity code is a misfiled fiscal
 * document. `./finalize` resolves every field from `eta_tenant_config`.
 */
export type InvoiceWireContext = {
  /** `issuer.id` — "Registration number. For business in Egypt must be
   *  registration number." Same value as the receipt's `seller.rin`. */
  rin: string;
  /** `issuer.name` — "Registration name of the company." */
  sellerName: string;
  /** `issuer.address.branchID` — "Mandatory when issuer is of type B ... The
   *  code of the branch as registered with tax authority". Same column as the
   *  receipt's `seller.branchCode`; different wire name. */
  branchCode: string;
  /** `issuer.address` — Mandatory. */
  branchAddress: FiscalAddress;
  /** `taxpayerActivityCode` — "Tax activity code of the business issuing the
   *  document ... Must be valid activity type code." A DOCUMENT-level field on
   *  an invoice, where the receipt nests it under `seller`. */
  activityCode: string;
  /**
   * `internalId` — "Internal document ID used to link back to the ERP document
   * number. Value defined by the submitter."
   *
   * Mandatory, and load-bearing beyond identification: an invoice carries no
   * uuid of its own at submission time, so ETA's Submit Documents response keys
   * both `acceptedDocuments` and `rejectedDocuments` entries on this value. It
   * is how a 202 is matched back to the row that produced it. `./finalize`
   * passes `orders.orderNumber`, which is unique tenant-wide.
   */
  internalId: string;
  /** "Must be `1.0` for this version" — or `"0.9"` while no signer is
   *  configured. See `InvoiceDocumentTypeVersion`. */
  documentTypeVersion: InvoiceDocumentTypeVersion;
};

/**
 * The `signatures` element — "Structure containing one or two digital
 * signatures. At least signature of the Issuer must be present. Signature of the
 * Service provider is optional.", each entry being `{ type, value }` where
 * `value` is a "Signature value that contains CADES-BES structure containing
 * signer certificate, hash value signed and actual signature value."
 *
 * ETA's own signed sample spells the entry's first key `signatureType`, not
 * `type` — the same page-versus-sample naming split resolved above — so that is
 * what `attachSignatures` emits.
 */
export type InvoiceSignature = { signatureType: "I" | "S"; value: string };

/**
 * One `invoiceLines` element.
 *
 * KEY ORDER IS ETA'S SAMPLE'S: description, itemType, itemCode, unitType,
 * quantity, internalCode, salesTotal, total, valueDifference, totalTaxableFees,
 * netTotal, itemsDiscount, unitValue, discount, taxableItems.
 *
 * OPTIONAL FIELDS ARE OMITTED WHEN ZERO rather than emitted as `0.00`, which is
 * the same rule `toItemData` applies to the receipt's `commercialDiscountData`
 * and `taxableItems` — and it is not cosmetic: `canonicalSerialize` hashes a
 * present key whatever its value, so emitting an optional zero changes the
 * signed bytes. The three Optional slots this touches are `valueDifference`,
 * `totalTaxableFees` and `itemsDiscount`; `discount` and `taxableItems` follow
 * the same rule.
 *
 * `totalTaxableFees` is emitted from the line's own T5-T12 `taxableItems`, which
 * is how Main Calculations rule 42 itself defines the term, so the field and the
 * equation's term cannot disagree. ServeOS emits none today, so it is always
 * absent.
 */
function toInvoiceLine(line: FiscalDocLine): Record<string, unknown> {
  const netTotal = assertDecimal(line.lineTotal, "netTotal");
  const discount = assertDecimal(line.discountAmount, "discount.amount");
  // "salesTotal: Total amount for the invoice line considering quantity and unit
  // price" — i.e. before the discount that `netTotal` has already had taken off.
  const salesTotal = addDecimal("salesTotal", netTotal, discount);
  const valueDifference = assertDecimal(line.valueDifference ?? "0.00", "valueDifference");
  const taxableFees = taxableFeesOf(line);

  return {
    description: line.description,
    itemType: itemType(line.codeSource),
    itemCode: line.itemCode,
    unitType: line.unitType,
    quantity: line.quantity,
    // Optional on an invoice line ("can be used to simplify references back to
    // existing solution") where receipt v1.2 marks it Mandatory; always present
    // either way, because `FiscalDocLine` requires it.
    internalCode: line.internalCode,
    salesTotal: dec(salesTotal, "salesTotal"),
    total: dec(lineTotal(line), "line total"),
    ...(isZeroDecimal(valueDifference) ? {} : { valueDifference: dec(valueDifference, "valueDifference") }),
    ...(isZeroDecimal(taxableFees) ? {} : { totalTaxableFees: dec(taxableFees, "totalTaxableFees") }),
    netTotal: dec(netTotal, "netTotal"),
    // "itemsDiscount: Non-taxable items discount." ServeOS has no non-taxable
    // discount concept — every discount it applies reduces the VAT base — so it
    // is always absent and the whole discount travels in `discount.amount`.
    unitValue: unitValue(line),
    // "the structure defining the discount applied on a single unit sold" — but
    // its `amount` is defined as "amount of discount provided to customer for
    // this item. Should be smaller or equal to value Total", and `salesTotal` is
    // the LINE's figure, so a line-level amount is the only reading under which
    // `netTotal = salesTotal - discount` holds. `rate` is Optional and omitted:
    // ServeOS stores discount money, not a percentage, and deriving one would be
    // inventing precision it never had.
    ...(isZeroDecimal(discount) ? {} : { discount: { amount: dec(discount, "discount.amount") } }),
    ...(line.taxes.length > 0 ? { taxableItems: line.taxes.map(toTaxableItem) } : {}),
  };
}

/**
 * `unitValue` — invoice v1.0's Value structure, where the receipt family carries
 * a bare `unitPrice`.
 *
 * `amountSold` and `currencyExchangeRate` are Conditional: "Mandatory if
 * currencySold <> EGP. Should not have value otherwise". ServeOS is
 * single-currency EGP, so both are OMITTED — "should not have value" is a
 * prohibition, and emitting them as zero would both break that and change the
 * signed bytes.
 */
function unitValue(line: FiscalDocLine): Record<string, unknown> {
  return { currencySold: "EGP", amountEGP: dec(line.unitPrice, "unitValue.amountEGP") };
}

/** Rule 42's `TotalTaxableFees` term for one line: "Sum(itemData[*].
 *  taxableItems[taxType=T5-T12].amount)". */
function taxableFeesOf(line: FiscalDocLine): string {
  return sumDecimal(
    "totalTaxableFees",
    line.taxes.filter((tax) => /^T(?:[5-9]|1[0-2])$/.test(tax.taxType)).map((tax) => tax.amount),
  );
}

/**
 * `taxableItems[]` — key order taxType, amount, subType, rate, per ETA's sample.
 *
 * `subType` is Optional on an invoice line where receipt v1.2 marks it
 * Mandatory, but it is still REQUIRED here: `MissingTaxSubTypeError` is raised
 * exactly as the receipt mapper raises it, because a tax entry whose subtype was
 * never configured is a `product_tax_codes` gap the owner can fix, and shipping
 * it without one would file the tax under an unclassified rate. Refusing a
 * document ETA might have accepted is the deliberate side to err on for a
 * classification we simply do not have.
 */
function toTaxableItem(tax: FiscalTaxAmount, index: number): Record<string, unknown> {
  if (tax.taxSubType === null) throw new MissingTaxSubTypeError(tax.taxType, index);
  return {
    taxType: tax.taxType,
    amount: dec(tax.amount, "taxableItems.amount"),
    subType: tax.taxSubType,
    rate: dec(tax.rate, "taxableItems.rate"),
  };
}

/**
 * An Address, emitted with its Optional components dropped when absent.
 *
 * `canonicalSerialize` refuses null outright ("ETA publishes no serialization
 * rule for null; omit the property instead"), so absence has to be expressed by
 * omission — the same rule the receipt's `branchAddress` follows.
 */
function toAddress(address: FiscalAddress, branchCode?: string): Record<string, unknown> {
  return {
    ...(branchCode === undefined ? {} : { branchID: branchCode }),
    country: address.country,
    governate: address.governate,
    regionCity: address.regionCity,
    street: address.street,
    buildingNumber: address.buildingNumber,
    ...(address.postalCode ? { postalCode: address.postalCode } : {}),
    ...(address.floor ? { floor: address.floor } : {}),
    ...(address.room ? { room: address.room } : {}),
    ...(address.landmark ? { landmark: address.landmark } : {}),
    ...(address.additionalInformation ? { additionalInformation: address.additionalInformation } : {}),
  };
}

/**
 * The invoice's own totals equations, on the document about to be emitted.
 *
 * The per-line rules and rule 26 are the receipt module's, imported and reused.
 * What is asserted HERE is the pair invoice v1.0 states in its own words and
 * which differ from the receipt's:
 *
 *   "netAmount: TotalSales – TotalDiscount"
 *   "totalAmount: Total amount of the invoice calculated as NetAmount + Totals
 *    of tax amounts"
 *
 * A receipt states `totalAmount = Sum(itemData.total) - extraReceiptDiscount +
 * adjustment` instead. The two coincide for every document ServeOS emits (no
 * document-level extra discount, no adjustment slot on an invoice at all), which
 * is exactly why the invoice's own form is asserted rather than the receipt's
 * borrowed: they would agree right up until they did not.
 */
function assertInvoiceTotalsReconcile(doc: FiscalDocument, totals: InvoiceTotals): void {
  for (const [index, line] of doc.lines.entries()) assertLineIsWellFormed(line, index);

  const netFromTotals = subtractDecimal("netAmount", totals.totalSalesAmount, totals.totalDiscountAmount);
  if (compareDecimal(netFromTotals, totals.netAmount) !== 0) {
    throw new EtaTotalsMismatchError(totals.netAmount, netFromTotals, "netAmount = totalSalesAmount - totalDiscountAmount");
  }

  const taxSum = sumDecimal("taxTotals", totals.taxTotals.map((tax) => tax.amount));
  const computed = subtractDecimal(
    "totalAmount", addDecimal("totalAmount", totals.netAmount, taxSum), totals.extraDiscountAmount);
  if (compareDecimal(computed, doc.total) !== 0) {
    throw new EtaTotalsMismatchError(doc.total, computed, "totalAmount = netAmount + Sum(taxTotals.amount) - extraDiscountAmount");
  }

  assertTaxTotalsMatchLines(doc.lines, totals.taxTotals);
}

type InvoiceTotals = {
  totalSalesAmount: string;
  totalDiscountAmount: string;
  netAmount: string;
  taxTotals: { taxType: string; amount: string }[];
  extraDiscountAmount: string;
  totalItemsDiscountAmount: string;
};

/**
 * Builds the invoice v1.0 (or v0.9) JSON for one document, WITHOUT its
 * signatures.
 *
 * Unsigned on purpose, and this is the pipeline rather than an omission: the
 * signature is computed over this document's own canonical serialization
 * ("Create document XML or JSON (no signature element yet) for a single
 * document" -> canonicalize -> SHA-256 -> CAdES-BES -> "Include Base64 encoded
 * CADES-BES signature into original document ... in a new element"), so the
 * unsigned form has to exist first and `attachSignatures` puts the result back
 * in afterwards. For a v0.9 submission there is no second step at all.
 *
 * NO `header` AND NO `uuid`. Invoice v1.0's root has neither; `documentType` and
 * `documentTypeVersion` sit directly on the document and the identifiers are
 * ETA's to assign. Nothing here is hashed into an identity.
 */
export function toWireInvoice(doc: FiscalDocument, ctx: InvoiceWireContext): Record<string, unknown> {
  if (doc.docType !== "e_invoice") {
    // A plain Error, not a `FiscalDocumentError`: this is a wiring mistake in
    // our own composition, not a tenant's data problem, and it must not be
    // reported to an owner as one. `finalize.ts` refuses the mirror case in the
    // same words.
    throw new Error(`fiscal: docType ${doc.docType} reached the invoice mapper — only e_invoice maps to invoice v1.0`);
  }
  assertReceiverIdentified(doc);

  const lines = doc.lines.map(toInvoiceLine);
  const totals: InvoiceTotals = {
    // "Sum all all InvoiceLine/SalesTotal items".
    totalSalesAmount: sumDecimal(
      "totalSalesAmount", doc.lines.map((line) => addDecimal("salesTotal", line.lineTotal, line.discountAmount))),
    // "Total amount of discounts: sum of all Discount amount elements of
    // InvoiceLine items."
    totalDiscountAmount: sumDecimal("totalDiscountAmount", doc.lines.map((line) => line.discountAmount)),
    // "TotalSales – TotalDiscount", which line by line is Σ netTotal.
    netAmount: sumDecimal("netAmount", doc.lines.map((line) => line.lineTotal)),
    taxTotals: foldTaxTotalsByType(doc.taxTotals),
    // Mandatory, and zero: the order-level discount rides on the lines. See
    // `buildInvoice`.
    extraDiscountAmount: assertDecimal(doc.discountTotal, "extraDiscountAmount"),
    // Mandatory, and zero: `itemsDiscount` is ETA's NON-TAXABLE item discount,
    // which ServeOS has no concept of.
    totalItemsDiscountAmount: "0.00",
  };

  assertInvoiceTotalsReconcile(doc, totals);

  return {
    issuer: {
      address: toAddress(ctx.branchAddress, ctx.branchCode),
      // "B for business in Egypt, P for natural person, F for foreigner. Note
      // that P and F are reserved values for future use." — so B is the only
      // legal issuer type today, and ServeOS tenants are businesses regardless.
      type: "B",
      id: ctx.rin,
      name: ctx.sellerName,
    },
    receiver: {
      address: toAddress(doc.buyer!.address!),
      type: doc.buyer!.type,
      id: doc.buyer!.id!,
      name: doc.buyer!.name!,
    },
    documentType: DOCUMENT_TYPE_INVOICE,
    documentTypeVersion: ctx.documentTypeVersion,
    dateTimeIssued: doc.issuedAt,
    taxpayerActivityCode: ctx.activityCode,
    internalID: ctx.internalId,
    // purchaseOrderReference / purchaseOrderDescription / salesOrderReference /
    // salesOrderDescription / proformaInvoiceNumber / payment / delivery /
    // serviceDeliveryDate are all Optional and all omitted: ServeOS stores no
    // purchase-order reference, no issuer bank details and no shipping terms,
    // and an omitted optional is the only honest spelling of "we do not have
    // this" — `canonicalSerialize` refuses null and an empty string is a claim.
    invoiceLines: lines,
    totalDiscountAmount: dec(totals.totalDiscountAmount, "totalDiscountAmount"),
    totalSalesAmount: dec(totals.totalSalesAmount, "totalSalesAmount"),
    netAmount: dec(totals.netAmount, "netAmount"),
    taxTotals: totals.taxTotals.map((tax) => ({ taxType: tax.taxType, amount: dec(tax.amount, "taxTotals.amount") })),
    totalAmount: dec(doc.total, "totalAmount"),
    extraDiscountAmount: dec(totals.extraDiscountAmount, "extraDiscountAmount"),
    totalItemsDiscountAmount: dec(totals.totalItemsDiscountAmount, "totalItemsDiscountAmount"),
  };
}

/**
 * The document carries a complete type-B receiver.
 *
 * `buildInvoice` already refuses an incomplete one, so this is the wire's own
 * backstop for a `FiscalDocument` assembled some other way — the same division
 * `assertBuyerIdentified` keeps on the receipt side, and the reason the
 * non-null assertions in `toWireInvoice` are safe.
 */
function assertReceiverIdentified(doc: FiscalDocument): void {
  const buyer = doc.buyer;
  const missing: string[] = [];
  if (!buyer) missing.push("receiver");
  else {
    if (!buyer.id) missing.push("id");
    if (!buyer.name) missing.push("name");
    if (!buyer.address) missing.push("address");
  }
  if (missing.length > 0) throw new BuyerIdRequiredError(buyer?.type ?? "B", doc.total, "0", missing);
}

/**
 * Puts the CAdES-BES signature(s) into the document, as the LAST property.
 *
 * Step 5 of ETA's signature-creation process — "Include Base64 encoded CADES-BES
 * signature into original document XML or document JSON in a new element" — and
 * last because that is where ETA's own signed sample (`files/one-doc-I.json`)
 * carries it, immediately after `totalItemsDiscountAmount`. Position matters for
 * the same reason everything else here does: it is part of the transmitted
 * bytes, and a verifier re-canonicalizing the document without the signatures
 * element must land on the text that was actually signed. Appending keeps the
 * unsigned prefix byte-identical.
 *
 * Returns a NEW object; the unsigned document passed in is the one that was
 * hashed and must not move.
 */
export function attachSignatures(
  wire: Record<string, unknown>, signatures: InvoiceSignature[],
): Record<string, unknown> {
  if (signatures.length === 0) return wire;
  return { ...wire, signatures: signatures.map((s) => ({ signatureType: s.signatureType, value: s.value })) };
}
