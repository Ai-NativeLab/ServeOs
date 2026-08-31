import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInvoice } from "./build-invoice";
import { buildReceipt, aggregateTaxTotals } from "./build-document";
import { toWireInvoice, attachSignatures, type InvoiceWireContext } from "./eta-invoice-wire";
import { toWireReceipt, assertLineTaxesDerivable, foldTaxTotalsByType, type WireContext } from "./eta-wire";
import { canonicalSerialize, stringifyWire } from "./serialize";
import { sumDecimal } from "./decimal";
import { EtaTotalsMismatchError, BuyerIdRequiredError, MissingTaxCodeError, FeeLineConfigMissingError } from "./errors";
import type {
  FiscalDocument, FiscalDocLine, FiscalInvoiceInput, FiscalSaleInput, FiscalInvoiceBuyer, FeeLineConfig,
} from "./provider";
import type { ProductTaxCode } from "./schema";
import type { Order, OrderItem } from "@/server/ordering/schema";
import type { OrderPayment } from "@/server/pos/tender-schema";

/**
 * The B2B invoice engine, tested at three levels:
 *
 *   1. THE BUILDER — receiver block, mandatory-field refusal, and money parity
 *      with the e-receipt built from the identical sale.
 *   2. THE WIRE — key ORDER against ETA's own published invoice
 *      (`__fixtures__/one-doc.json`, the same document `serialize.test.ts`
 *      proves `canonicalSerialize` reproduces byte for byte), plus the invoice's
 *      own totals equations.
 *   3. THE WIDENED RULE 42 — the zero-case pin that proves the sale and return
 *      paths are unchanged, a fee-bearing line the reduced form would have
 *      wrongly refused, and mixed-tax-type `taxTotals` grouping.
 */

const PRODUCT_A = "11111111-1111-4111-8111-111111111111";
const PRODUCT_B = "22222222-2222-4222-8222-222222222222";
const PLACED_AT = new Date("2026-07-24T09:30:15.000Z");

/**
 * The SAME fixture sale as `build-document.test.ts`, deliberately: the money
 * parity test below compares an invoice and an e-receipt built from it, and that
 * comparison is only meaningful if the sale is one a real `computeOrderTotals`
 * would have persisted.
 *
 *   line A  100.00 x 2 = 200.00, line discount 20.00 -> lineTotal 180.00
 *   line B   50.00 x 1 =  50.00, line discount  0.00 -> lineTotal  50.00
 *   sum(lineTotal) 230.00 - order discount 30.00     -> subtotal   200.00
 *   service charge 10%  20.00 -> taxable 220.00, VAT 14%             30.80
 *   total = 220.00 + 30.80 + delivery 25.00                        = 275.80
 */
const order: Order = {
  id: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
  tenantId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
  branchId: "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c",
  orderNumber: 1042,
  status: "completed",
  fulfillmentType: "delivery",
  channel: "pos",
  paymentStatus: "paid",
  paymentMethod: "cash",
  paymentReference: null,
  paymentProofUrl: null,
  paymentProviderRef: null,
  customerName: "Walk-in",
  customerPhone: "+201000000000",
  notes: null,
  cashierUserId: null,
  rxReviewStatus: "not_required",
  customerId: null,
  discountAmount: "30.00",
  discountReason: "Loyalty",
  deliveryAreaId: null,
  deliveryAreaNameSnapshot: null,
  deliveryAddressText: null,
  subtotal: "200.00",
  vatRateSnapshot: "14",
  vatAmount: "30.80",
  serviceChargeAmount: "20.00",
  deliveryFee: "25.00",
  total: "275.80",
  statusToken: "tok",
  scheduledFor: null,
  cancelReason: null,
  placedAt: PLACED_AT,
  updatedAt: PLACED_AT,
};

const item = (over: Partial<OrderItem> & Pick<OrderItem, "id" | "productId">): OrderItem => ({
  tenantId: order.tenantId,
  orderId: order.id,
  variantId: null,
  variantNameEn: null,
  variantNameAr: null,
  nameEn: "Item",
  nameAr: "صنف",
  unitBasePrice: "100.00",
  quantity: 1,
  lineTotal: "100.00",
  discountAmount: "0.00",
  selectedModifiers: [],
  dimensions: null,
  ...over,
});

const items: OrderItem[] = [
  item({
    id: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
    productId: PRODUCT_A,
    nameEn: "Shawarma Plate",
    unitBasePrice: "100.00",
    quantity: 2,
    lineTotal: "180.00",
    discountAmount: "20.00",
  }),
  item({
    id: "2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a",
    productId: PRODUCT_B,
    nameEn: "Mint Lemonade",
    unitBasePrice: "50.00",
    quantity: 1,
    lineTotal: "50.00",
  }),
];

const taxCode = (productId: string, over: Partial<ProductTaxCode> = {}): ProductTaxCode => ({
  id: `tc-${productId}`,
  tenantId: order.tenantId,
  productId,
  codeSource: "gs1",
  itemCode: "10007020",
  egsApprovalStatus: null,
  taxType: "T1",
  taxSubType: "V009",
  unitType: "EA",
  createdAt: PLACED_AT,
  ...over,
});

const taxCodes: ProductTaxCode[] = [taxCode(PRODUCT_A), taxCode(PRODUCT_B, { itemCode: "10007021" })];

const SERVICE_CHARGE: FeeLineConfig = {
  itemCode: "1234567890124", codeSource: "gs1", taxType: "T1",
  taxSubType: "V009", unitType: "EA", description: "Service charge", internalCode: "SVC",
};
const DELIVERY: FeeLineConfig = {
  itemCode: "1234567890125", codeSource: "gs1", taxType: "T1",
  taxSubType: "V009", unitType: "EA", description: "Delivery", internalCode: "DLV",
};

const payments: OrderPayment[] = [];

const buyer: FiscalInvoiceBuyer = {
  rin: "313717919",
  name: "Receiver Company LLC",
  address: {
    country: "EG",
    governate: "Cairo",
    regionCity: "Nasr City",
    street: "580 Clementina Key",
    buildingNumber: "Bldg. 0",
    postalCode: "68030",
  },
};

const invoiceInput = (over: Partial<FiscalInvoiceInput> = {}): FiscalInvoiceInput => ({
  order, items, taxCodes, payments, buyer,
  feeLines: { serviceCharge: SERVICE_CHARGE, delivery: DELIVERY },
  ...over,
});

/** The e-receipt built from the IDENTICAL sale — the money-parity counterpart. */
const saleInput = (): FiscalSaleInput => ({
  order, items, taxCodes, payments,
  feeLines: { serviceCharge: SERVICE_CHARGE, delivery: DELIVERY },
  previousUuid: "",
  deviceSerial: "POS-1",
});

const invoiceCtx: InvoiceWireContext = {
  rin: "200173707",
  sellerName: "Fiscal Co",
  branchCode: "1",
  branchAddress: {
    country: "EG",
    governate: "Cairo",
    regionCity: "Nasr City",
    street: "17 Nabil Al Wakad",
    buildingNumber: "17",
  },
  activityCode: "5610",
  internalId: "1042",
  documentTypeVersion: "0.9",
};

const receiptCtx: WireContext = {
  rin: "200173707",
  sellerName: "Fiscal Co",
  branchCode: "1",
  branchAddress: invoiceCtx.branchAddress,
  deviceSerial: "POS-1",
  activityCode: "5610",
  receiptNumber: "1042",
};

// ---------------------------------------------------------------------------
// 1. The builder
// ---------------------------------------------------------------------------

describe("buildInvoice — identity and the receiver block", () => {
  it("carries no uuid, no chain link and no reference — ETA assigns an invoice's identity", () => {
    const doc = buildInvoice(invoiceInput());
    expect(doc.docType).toBe("e_invoice");
    expect(doc.uuid).toBeNull();
    expect(doc.previousUuid).toBeNull();
    expect(doc.referenceUuid).toBeNull();
    expect(doc.referenceOldUuid).toBeNull();
  });

  it("maps the buyer to a type-B receiver with its registration number, name and address", () => {
    expect(buildInvoice(invoiceInput()).buyer).toEqual({
      type: "B",
      id: "313717919",
      name: "Receiver Company LLC",
      address: buyer.address,
    });
  });

  /**
   * THE MANDATORY-RECEIVER-FIELD LIST, pinned as a test rather than only as
   * prose, because round 2 Task 4's zod has to validate exactly this set at the
   * capture boundary. Invoice v1.0 marks `receiver.id`/`name`/`address`
   * Conditional ("Optional if person buyer and invoice amount less than
   * threshold limit defined"), so all three are Mandatory for a type-B receiver,
   * and Receiver Address marks these five Mandatory within it.
   *
   * NONE of them is derivable from ServeOS's own order data — `orders` stores a
   * customerName and a customerPhone and nothing else about a buyer.
   */
  it("refuses an empty receiver, naming every mandatory field ETA requires", () => {
    const empty: FiscalInvoiceBuyer = {
      rin: "",
      name: "   ",
      address: { country: "", governate: "", regionCity: "", street: "", buildingNumber: "" },
    };

    try {
      buildInvoice(invoiceInput({ buyer: empty }));
      expect.unreachable("buildInvoice should refuse an unidentified business receiver");
    } catch (err) {
      expect(err).toBeInstanceOf(BuyerIdRequiredError);
      expect((err as BuyerIdRequiredError).missing).toEqual([
        "id",
        "name",
        "address.country",
        "address.governate",
        "address.regionCity",
        "address.street",
        "address.buildingNumber",
      ]);
    }
  });

  it("refuses a receiver missing only one address component", () => {
    const partial: FiscalInvoiceBuyer = { ...buyer, address: { ...buyer.address, governate: "" } };
    expect(() => buildInvoice(invoiceInput({ buyer: partial }))).toThrow(BuyerIdRequiredError);
  });

  it("still refuses an unclassified product and an unconfigured fee — the shared pipeline's guards apply", () => {
    expect(() => buildInvoice(invoiceInput({ taxCodes: [taxCodes[0]] }))).toThrow(MissingTaxCodeError);
    expect(() => buildInvoice(invoiceInput({ feeLines: { delivery: DELIVERY } }))).toThrow(FeeLineConfigMissingError);
  });
});

describe("buildInvoice — money parity with the e-receipt for the same sale", () => {
  const invoice = buildInvoice(invoiceInput());
  const receipt = buildReceipt(saleInput());

  it("produces byte-identical lines — it is the same pipeline, not a parallel one", () => {
    expect(invoice.lines).toEqual(receipt.lines);
  });

  it("reports the order's stored total verbatim and totals to it from the lines", () => {
    expect(invoice.total).toBe(order.total);
    // Σ (netTotal + tax) == totalAmount, which is ETA's own identity for both
    // families under a zero document-level discount.
    const summed = sumDecimal("line totals", invoice.lines.map((line) =>
      sumDecimal("line total", [line.lineTotal, ...line.taxes.map((tax) => tax.amount)])));
    expect(summed).toBe(order.total);
  });

  it("reports exactly the order's stored VAT, split across the same lines", () => {
    expect(sumDecimal("taxTotals", invoice.taxTotals.map((tax) => tax.amount))).toBe(order.vatAmount);
    expect(invoice.taxTotals).toEqual(receipt.taxTotals);
  });

  it("keeps the delivery line outside the taxable base, as the receipt does", () => {
    const delivery = invoice.lines.find((line) => line.internalCode === "DLV")!;
    expect(delivery.taxes).toEqual([]);
    expect(delivery.lineTotal).toBe("25.00");
  });

  it("differs from the receipt only in the document-level fields, never in the money", () => {
    expect(invoice.subtotal).toBe(receipt.subtotal);
    expect(invoice.feesTotal).toBe(receipt.feesTotal);
    expect(invoice.discountTotal).toBe(receipt.discountTotal);
    expect(invoice.issuedAt).toBe(receipt.issuedAt);
    expect(invoice.currency).toBe(receipt.currency);
  });
});

// ---------------------------------------------------------------------------
// 2. The wire mapper, against ETA's own published invoice
// ---------------------------------------------------------------------------

/**
 * ETA's published sample invoice — the SAME file `serialize.test.ts` proves
 * `canonicalSerialize` reproduces byte for byte against ETA's published
 * canonical output. That is what makes it a structural oracle: its key order is
 * demonstrably the order ETA serializes, not merely the order someone typed.
 *
 * Only ORDER is compared, never values: the fixture is a different sale, in a
 * different currency, with fields (purchase orders, bank details, shipping
 * terms) ServeOS does not store.
 */
function oracle(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(__dirname, "__fixtures__", "one-doc.json"), "utf8")) as Record<string, unknown>;
}

/** The keys of one object, in document order. */
const keysOf = (value: unknown): string[] => Object.keys(value as Record<string, unknown>);

/** `emitted`'s keys, in order, restricted to those the oracle also has — so an
 *  Optional field ServeOS omits does not make the comparison vacuous, while any
 *  REORDERING of the shared fields fails. */
function sharedOrder(emitted: unknown, reference: unknown): { emitted: string[]; expected: string[] } {
  const referenceKeys = keysOf(reference);
  const emittedKeys = keysOf(emitted);
  return {
    emitted: emittedKeys.filter((key) => referenceKeys.includes(key)),
    expected: referenceKeys.filter((key) => emittedKeys.includes(key)),
  };
}

describe("toWireInvoice — structural oracle against ETA's published invoice", () => {
  const wire = toWireInvoice(buildInvoice(invoiceInput()), invoiceCtx);
  const reference = oracle();

  it("emits the document's own properties in ETA's order", () => {
    const { emitted, expected } = sharedOrder(wire, reference);
    expect(emitted).toEqual(expected);
    // Not vacuous: the shared set has to actually cover the document.
    expect(emitted).toEqual([
      "issuer", "receiver", "documentType", "documentTypeVersion", "dateTimeIssued",
      "taxpayerActivityCode", "internalID", "invoiceLines",
      "totalDiscountAmount", "totalSalesAmount", "netAmount", "taxTotals",
      "totalAmount", "extraDiscountAmount", "totalItemsDiscountAmount",
    ]);
  });

  it("emits issuer, receiver and both addresses in ETA's order (address FIRST, branchID inside it)", () => {
    for (const section of ["issuer", "receiver"] as const) {
      const { emitted, expected } = sharedOrder(wire[section], reference[section]);
      expect(emitted, section).toEqual(expected);
      expect(emitted, section).toEqual(["address", "type", "id", "name"]);

      const address = sharedOrder(
        (wire[section] as Record<string, unknown>).address,
        (reference[section] as Record<string, unknown>).address,
      );
      expect(address.emitted, `${section}.address`).toEqual(address.expected);
    }
    expect(keysOf((wire.issuer as Record<string, unknown>).address)[0]).toBe("branchID");
    expect(keysOf((wire.receiver as Record<string, unknown>).address)).not.toContain("branchID");
  });

  it("emits an invoice line, its unitValue, its discount and its taxableItems in ETA's order", () => {
    const referenceLine = (reference.invoiceLines as unknown[])[0];
    // The FIRST line carries a discount, so it exercises the `discount`
    // structure's position between `unitValue` and `taxableItems`.
    const line = (wire.invoiceLines as Record<string, unknown>[])[0];
    expect(keysOf(line)).toContain("discount");

    const { emitted, expected } = sharedOrder(line, referenceLine);
    expect(emitted).toEqual(expected);
    expect(emitted).toEqual([
      "description", "itemType", "itemCode", "unitType", "quantity", "internalCode",
      "salesTotal", "total", "netTotal", "unitValue", "discount", "taxableItems",
    ]);

    const unit = sharedOrder(line.unitValue, (referenceLine as Record<string, unknown>).unitValue);
    expect(unit.emitted).toEqual(unit.expected);
    // Conditional and prohibited for EGP: "Mandatory if currencySold <> EGP.
    // Should not have value otherwise".
    expect(unit.emitted).toEqual(["currencySold", "amountEGP"]);

    const tax = sharedOrder(
      (line.taxableItems as unknown[])[0],
      ((referenceLine as Record<string, unknown>).taxableItems as unknown[])[0],
    );
    expect(tax.emitted).toEqual(tax.expected);
    expect(tax.emitted).toEqual(["taxType", "amount", "subType", "rate"]);

    const taxTotal = sharedOrder((wire.taxTotals as unknown[])[0], (reference.taxTotals as unknown[])[0]);
    expect(taxTotal.emitted).toEqual(taxTotal.expected);
  });

  it("omits every Optional field ServeOS cannot supply, rather than emitting it empty", () => {
    for (const absent of [
      "purchaseOrderReference", "purchaseOrderDescription", "salesOrderReference",
      "salesOrderDescription", "proformaInvoiceNumber", "payment", "delivery",
      "serviceDeliveryDate", "signatures",
    ]) {
      expect(Object.keys(wire), absent).not.toContain(absent);
    }
    // A line with no discount carries no `discount` structure at all. Both
    // PRODUCT lines carry one — the order-level discount is pushed down onto
    // them — so the delivery fee line, which takes no share of anything, is the
    // one that proves the omission.
    const undiscounted = (wire.invoiceLines as Record<string, unknown>[]).at(-1)!;
    expect(undiscounted.internalCode).toBe("DLV");
    expect(Object.keys(undiscounted)).not.toContain("discount");
    // ...and no taxableItems either: delivery sits outside ServeOS's taxable base.
    expect(Object.keys(undiscounted)).not.toContain("taxableItems");
    // No line carries a value difference or a taxable fee.
    for (const line of wire.invoiceLines as Record<string, unknown>[]) {
      expect(Object.keys(line)).not.toContain("valueDifference");
      expect(Object.keys(line)).not.toContain("totalTaxableFees");
      expect(Object.keys(line)).not.toContain("itemsDiscount");
    }
  });

  it("serializes without throwing, and its canonical text carries the document's own field names", () => {
    const text = canonicalSerialize(wire);
    expect(text.startsWith('"ISSUER""ADDRESS""BRANCHID""1"')).toBe(true);
    expect(text).toContain('"DOCUMENTTYPE""I""DOCUMENTTYPEVERSION""0.9"');
    // No header, no uuid, no previousUUID — the receipt-family concepts.
    expect(text).not.toContain('"UUID"');
    expect(text).not.toContain('"PREVIOUSUUID"');
  });

  it("transmits decimal literals verbatim, exactly as the receipt path does", () => {
    const body = stringifyWire(wire);
    expect(body).toContain('"totalAmount":275.80');
    expect(body).toContain('"netAmount":245.00');
    // 30.80 of VAT, unquoted and with its trailing zero intact.
    expect(body).toContain('"taxTotals":[{"taxType":"T1","amount":30.80}]');
  });
});

describe("toWireInvoice — the invoice's own totals equations", () => {
  const wire = toWireInvoice(buildInvoice(invoiceInput()), invoiceCtx);

  /** Wire decimals travel as `WireDecimal` so their exact literal survives to
   *  the bytes ETA (and any signature) sees — never as JS numbers. */
  const literal = (value: unknown): string => (value as { literal: string }).literal;

  it('satisfies "netAmount: TotalSales - TotalDiscount"', () => {
    // Σ salesTotal 295.00 (the two product lines' pre-discount 200.00 + 50.00,
    // plus the 20.00 service charge and the 25.00 delivery fee)
    //   - totalDiscountAmount 50.00 (the 20.00 line discount + the 30.00
    //     order discount pushed down onto the lines)
    //   -> netAmount 245.00
    expect(literal(wire.totalSalesAmount)).toBe("295.00");
    expect(literal(wire.totalDiscountAmount)).toBe("50.00");
    expect(literal(wire.netAmount)).toBe("245.00");
  });

  it('satisfies "totalAmount: NetAmount + Totals of tax amounts"', () => {
    expect(literal(wire.totalAmount)).toBe("275.80"); // 245.00 + 30.80
  });

  it("emits the two Mandatory document-level discount slots as zero, never omitted", () => {
    expect(literal(wire.extraDiscountAmount)).toBe("0.00");
    expect(literal(wire.totalItemsDiscountAmount)).toBe("0.00");
  });

  it("refuses a document whose stored total contradicts its own lines", () => {
    const doc = buildInvoice(invoiceInput());
    const tampered: FiscalDocument = { ...doc, total: "999.99" };
    expect(() => toWireInvoice(tampered, invoiceCtx)).toThrow(EtaTotalsMismatchError);
  });

  it("refuses a document with an incomplete receiver even if the builder was bypassed", () => {
    const doc = buildInvoice(invoiceInput());
    const tampered: FiscalDocument = { ...doc, buyer: { type: "B", id: "313717919", name: "X" } };
    expect(() => toWireInvoice(tampered, invoiceCtx)).toThrow(BuyerIdRequiredError);
  });

  it("refuses a non-invoice document outright rather than mis-mapping it", () => {
    expect(() => toWireInvoice(buildReceipt(saleInput()), invoiceCtx)).toThrow(/only e_invoice/);
  });
});

describe("attachSignatures", () => {
  const unsigned = toWireInvoice(buildInvoice(invoiceInput()), { ...invoiceCtx, documentTypeVersion: "1.0" });

  it("appends signatures as the document's LAST property, leaving the signed prefix byte-identical", () => {
    const signed = attachSignatures(unsigned, [{ signatureType: "I", value: "BASE64-CADES" }]);
    expect(Object.keys(signed).at(-1)).toBe("signatures");
    expect(signed.signatures).toEqual([{ signatureType: "I", value: "BASE64-CADES" }]);
    // The bytes the signature was taken over are still a prefix of the bytes
    // transmitted — which is what lets a verifier re-derive them.
    expect(canonicalSerialize(signed).startsWith(canonicalSerialize(unsigned))).toBe(true);
  });

  it("returns the document untouched when there is nothing to attach", () => {
    expect(attachSignatures(unsigned, [])).toBe(unsigned);
  });
});

// ---------------------------------------------------------------------------
// 3. The widened rule 42, and taxTotals grouping
// ---------------------------------------------------------------------------

/** A minimal line, VAT-only, at 14% on a 100.00 base. */
const plainLine = (over: Partial<FiscalDocLine> = {}): FiscalDocLine => ({
  itemCode: "10007020",
  internalCode: "p",
  codeSource: "gs1",
  taxType: "T1",
  taxSubType: "V009",
  unitType: "EA",
  description: "Item",
  quantity: 1,
  unitPrice: "100.00",
  discountAmount: "0.00",
  taxes: [{ taxType: "T1", taxSubType: "V009", rate: "14", amount: "14.00" }],
  lineTotal: "100.00",
  ...over,
});

describe("assertLineTaxesDerivable — the widened rule 42", () => {
  /**
   * THE ZERO-CASE PIN. Rule 42's full equation is
   *
   *   amount = (T2 + netSale + Σ T5-T12 + valueDifference + T3) * rate / 100
   *
   * and every ServeOS receipt and return receipt emits only T1, so every added
   * term is zero and the equation collapses to the reduced `netSale * rate / 100`
   * the assertion used to check. This is that collapse, asserted rather than
   * reasoned about: the widened form accepts exactly what the reduced form
   * accepted and refuses exactly what it refused, at the same boundary.
   */
  it("is exactly the old reduced form for a line carrying only T1", () => {
    expect(() => assertLineTaxesDerivable(plainLine(), 0)).not.toThrow();

    // ETA's published ± 0.5 tolerance, both sides of it, unchanged by widening.
    expect(() => assertLineTaxesDerivable(plainLine({
      taxes: [{ taxType: "T1", taxSubType: "V009", rate: "14", amount: "14.50" }],
    }), 0)).not.toThrow();
    expect(() => assertLineTaxesDerivable(plainLine({
      taxes: [{ taxType: "T1", taxSubType: "V009", rate: "14", amount: "14.51" }],
    }), 0)).toThrow(EtaTotalsMismatchError);
  });

  it("leaves every real sale and return document unchanged — their added terms are all zero", () => {
    // Built through the real builders, not hand-typed: if the widening had
    // changed the arithmetic for these families, the wire mappers would refuse
    // them here.
    expect(() => toWireReceipt(buildReceipt(saleInput()), receiptCtx)).not.toThrow();
    expect(() => toWireInvoice(buildInvoice(invoiceInput()), invoiceCtx)).not.toThrow();
  });

  /**
   * A T-FEE-BEARING LINE — the shape the widening exists for, and the one the
   * reduced form would have refused outright.
   *
   * netSale 100.00 with a T5 taxable fee of 20.00 puts rule 42's base at 120.00,
   * so the correct T1 amount is 16.80. The reduced form would have expected
   * 14.00 and rejected 16.80 as 2.80 out — six times ETA's tolerance — for a
   * document ETA itself would have accepted.
   */
  it("accepts a T1 amount derived from a base that includes a T5-T12 taxable fee", () => {
    const withFee = plainLine({
      taxes: [
        { taxType: "T1", taxSubType: "V009", rate: "14", amount: "16.80" },
        { taxType: "T5", taxSubType: "F001", rate: "20", amount: "20.00" },
      ],
    });
    expect(() => assertLineTaxesDerivable(withFee, 0)).not.toThrow();

    // And it is still a real check: the reduced form's own answer is now wrong.
    const reduced = plainLine({
      taxes: [
        { taxType: "T1", taxSubType: "V009", rate: "14", amount: "14.00" },
        { taxType: "T5", taxSubType: "F001", rate: "20", amount: "20.00" },
      ],
    });
    expect(() => assertLineTaxesDerivable(reduced, 0)).toThrow(EtaTotalsMismatchError);
  });

  it("includes T2, T3 and valueDifference in the base, each on its own", () => {
    const cases: [string, Partial<FiscalDocLine>][] = [
      // T2 of 10.00 -> base 110.00 -> 15.40
      ["T2", { taxes: [
        { taxType: "T1", taxSubType: "V009", rate: "14", amount: "15.40" },
        { taxType: "T2", taxSubType: "TT01", rate: "10", amount: "10.00" },
      ] }],
      // T3 of 5.00 -> base 105.00 -> 14.70
      ["T3", { taxes: [
        { taxType: "T1", taxSubType: "V009", rate: "14", amount: "14.70" },
        { taxType: "T3", taxSubType: "TT02", rate: "0", amount: "5.00" },
      ] }],
      // valueDifference 50.00 -> base 150.00 -> 21.00
      ["valueDifference", { valueDifference: "50.00", taxes: [
        { taxType: "T1", taxSubType: "V009", rate: "14", amount: "21.00" },
      ] }],
    ];
    for (const [name, over] of cases) {
      expect(() => assertLineTaxesDerivable(plainLine(over), 0), name).not.toThrow();
    }
  });

  it("does not re-derive a non-T1 amount — rule 42 is written about T1 alone", () => {
    // A T5 amount that no equation here can check passes through; only its
    // positivity is enforced. Refusing it would be inventing a rule.
    const line = plainLine({
      taxes: [
        { taxType: "T1", taxSubType: "V009", rate: "14", amount: "16.80" },
        { taxType: "T5", taxSubType: "F001", rate: "999", amount: "20.00" },
      ],
    });
    expect(() => assertLineTaxesDerivable(line, 0)).not.toThrow();
  });
});

describe("aggregateTaxTotals — grouping by (taxType, subType)", () => {
  it("is byte-identical to the old single-entry form for every single-type document", () => {
    // THE PIN the widening must not break: one tax type, one subtype, one entry
    // carrying the whole stored VAT and the sale's own rate.
    const receipt = buildReceipt(saleInput());
    expect(receipt.taxTotals).toEqual([
      { taxType: "T1", taxSubType: "V009", rate: "14", amount: "30.80" },
    ]);
    expect(buildInvoice(invoiceInput()).taxTotals).toEqual(receipt.taxTotals);
  });

  it("emits nothing for a document whose lines carry no tax", () => {
    expect(aggregateTaxTotals([plainLine({ taxes: [] })])).toEqual([]);
  });

  it("keeps two subtypes of one tax type apart, so neither claims the other's rate", () => {
    const grouped = aggregateTaxTotals([
      plainLine({ taxes: [{ taxType: "T1", taxSubType: "V009", rate: "14", amount: "14.00" }] }),
      plainLine({ taxes: [{ taxType: "T1", taxSubType: "V002", rate: "5", amount: "5.00" }] }),
      plainLine({ taxes: [{ taxType: "T1", taxSubType: "V009", rate: "14", amount: "7.00" }] }),
    ]);
    expect(grouped).toEqual([
      { taxType: "T1", taxSubType: "V009", rate: "14", amount: "21.00" },
      { taxType: "T1", taxSubType: "V002", rate: "5", amount: "5.00" },
    ]);
  });

  it("separates genuinely different tax types, which the old form reported under one", () => {
    const grouped = aggregateTaxTotals([
      plainLine({ taxes: [
        { taxType: "T1", taxSubType: "V009", rate: "14", amount: "16.80" },
        { taxType: "T5", taxSubType: "F001", rate: "20", amount: "20.00" },
      ] }),
    ]);
    expect(grouped).toEqual([
      { taxType: "T1", taxSubType: "V009", rate: "14", amount: "16.80" },
      { taxType: "T5", taxSubType: "F001", rate: "20", amount: "20.00" },
    ]);
  });
});

describe("foldTaxTotalsByType — the wire's per-taxType shape", () => {
  it("is the identity for every document ServeOS emits today", () => {
    const totals = buildInvoice(invoiceInput()).taxTotals;
    expect(foldTaxTotalsByType(totals)).toEqual([{ taxType: "T1", amount: "30.80" }]);
  });

  it("sums subtypes back together, because ETA requires the type to be unique", () => {
    expect(foldTaxTotalsByType([
      { taxType: "T1", taxSubType: "V009", rate: "14", amount: "21.00" },
      { taxType: "T1", taxSubType: "V002", rate: "5", amount: "5.00" },
      { taxType: "T5", taxSubType: "F001", rate: "20", amount: "20.00" },
    ])).toEqual([
      { taxType: "T1", amount: "26.00" },
      { taxType: "T5", amount: "20.00" },
    ]);
  });
});
