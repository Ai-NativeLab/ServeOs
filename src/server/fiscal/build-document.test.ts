import { describe, it, expect } from "vitest";
import {
  buildReceipt,
  buildReturnReceipt,
  MissingTaxCodeError,
  FeeLineConfigMissingError,
  IrreconcilableOrderError,
  EmptyReturnReceiptError,
} from "./build-document";
import { EtaFiscalProvider } from "./eta-provider";
import { finalizeReceipt, stringifyWire } from "./serialize";
import { toWireReceipt, UnsupportedTaxTypeError, BuyerIdRequiredError, type WireContext } from "./eta-wire";
import { addDecimal } from "./decimal";
import type { FiscalSaleInput, FiscalRefundInput, FiscalDocument, FeeLineConfig, EtaConfig } from "./provider";
import type { ProductTaxCode } from "./schema";
import type { Order, OrderItem } from "@/server/ordering/schema";
import type { Refund, RefundLine } from "@/server/pos/refund-schema";
import type { OrderPayment } from "@/server/pos/tender-schema";

const PRODUCT_A = "11111111-1111-4111-8111-111111111111";
const PRODUCT_B = "22222222-2222-4222-8222-222222222222";
const PLACED_AT = new Date("2026-07-24T09:30:15.000Z");

/**
 * The fixture sale is arithmetically consistent with `computeOrderTotals`
 * (src/lib/order-totals.ts) at 14% VAT + 10% service charge, so the mapper is
 * exercised against numbers a real `placeOrder` would have persisted:
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
  taxSubType: "V001",
  unitType: "EA",
  createdAt: PLACED_AT,
  ...over,
});

const taxCodes: ProductTaxCode[] = [
  taxCode(PRODUCT_A),
  taxCode(PRODUCT_B, { codeSource: "egs", itemCode: "EG-2001", unitType: "PCE" }),
];

const feeConfig = (over: Partial<FeeLineConfig>): FeeLineConfig => ({
  itemCode: "10008000",
  codeSource: "gs1",
  taxType: "T1",
  taxSubType: "V001",
  unitType: "EA",
  description: "Service charge",
  internalCode: "SVC",
  ...over,
});

const feeLines = {
  serviceCharge: feeConfig({}),
  delivery: feeConfig({ itemCode: "10009000", description: "Delivery", internalCode: "DLV" }),
};

const payment = (over: Partial<OrderPayment> & Pick<OrderPayment, "id" | "method" | "amount">): OrderPayment => ({
  tenantId: order.tenantId,
  orderId: order.id,
  tipAmount: "0",
  tenderedAmount: null,
  changeAmount: null,
  reference: null,
  takenByUserId: "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a",
  shiftId: null,
  clientPaymentId: `cp-${over.id}`,
  createdAt: PLACED_AT,
  ...over,
});

const payments: OrderPayment[] = [payment({ id: "p1", method: "cash", amount: "275.80" })];

const saleInput: FiscalSaleInput = {
  order,
  items,
  taxCodes,
  payments,
  feeLines,
  previousUuid: "c".repeat(64),
  deviceSerial: "POS-001",
};

const wireCtx: WireContext = {
  rin: "200173707",
  sellerName: "ABC Corp",
  branchCode: "ABC",
  branchAddress: { country: "EG", governate: "Giza Governorate", regionCity: "Dokki", street: "17 Nabil Al Wakad", buildingNumber: "17" },
  deviceSerial: "POS-001",
  activityCode: "5610",
  receiptNumber: "1042",
};

describe("buildReceipt", () => {
  it("builds an e_receipt with a null uuid and the supplied chain head", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.docType).toBe("e_receipt");
    // The uuid is computed later, from the serialized WIRE document (finalizeReceipt).
    expect(doc.uuid).toBeNull();
    expect(doc.previousUuid).toBe("c".repeat(64));
    expect(doc.referenceUuid).toBeNull();
    expect(doc.currency).toBe("EGP");
  });

  it("defaults the buyer to an unidentified natural person", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.buyer).toEqual({ type: "P" });
  });

  it("maps each line's fiscal codes from that product's ProductTaxCode", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.lines[0]).toMatchObject({
      itemCode: "10007020",
      codeSource: "gs1",
      taxType: "T1",
      taxSubType: "V001",
      unitType: "EA",
      description: "Shawarma Plate",
      quantity: 2,
    });
    expect(doc.lines[1]).toMatchObject({ itemCode: "EG-2001", codeSource: "egs", unitType: "PCE" });
  });

  it("sets internalCode from the product id", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.lines[0].internalCode).toBe(PRODUCT_A);
    expect(doc.lines[1].internalCode).toBe(PRODUCT_B);
  });

  it("maps the document total verbatim from orders.total, to the cent (F9)", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.total).toBe(order.total);
    expect(doc.total).toBe("275.80");
    expect(doc.subtotal).toBe("200.00");
  });

  it("derives unitPrice from the line's own totalSale, not the stored column", () => {
    // Main Calculations: "totalSale = quantity * unitPrice". For these lines
    // the derived price coincides with the stored one (2 x 100.00 = 180.00 +
    // 20.00 discount), but it is computed, never copied — see the modifier
    // case below for why the stored column cannot be trusted.
    const doc = buildReceipt(saleInput);
    expect(doc.lines[0].unitPrice).toBe("100.00000");
    expect(doc.lines[1].unitPrice).toBe("50.00000");
  });

  it("throws MissingTaxCodeError naming the product when a line has no tax code", () => {
    const input = { ...saleInput, taxCodes: [taxCode(PRODUCT_A)] };
    expect(() => buildReceipt(input)).toThrow(MissingTaxCodeError);
    try {
      buildReceipt(input);
      expect.unreachable("buildReceipt should have thrown");
    } catch (err) {
      expect((err as MissingTaxCodeError).productId).toBe(PRODUCT_B);
      expect((err as MissingTaxCodeError).message).toContain(PRODUCT_B);
    }
  });

  it("issues at the order's placedAt as second-precision ISO UTC", () => {
    expect(buildReceipt(saleInput).issuedAt).toBe("2026-07-24T09:30:15Z");
  });
});

describe("buildReceipt — modifier-priced lines (unitBasePrice excludes modifiers)", () => {
  // ordering/service.ts stores the BASE price for a plain product line and
  // keeps modifier price deltas only in selectedModifiers, while lineTotal
  // includes them. Here: base 100.00 x 2 = 200.00, but the line was actually
  // priced at 115.00 each (a 15.00 modifier), so lineTotal is 230.00.
  const modified = item({
    id: "m1",
    productId: PRODUCT_A,
    nameEn: "Shawarma Plate + extra meat",
    unitBasePrice: "100.00",
    quantity: 2,
    lineTotal: "230.00",
    discountAmount: "0.00",
    selectedModifiers: [
      { groupNameEn: "Extras", groupNameAr: "إضافات", optionNameEn: "Extra meat", optionNameAr: "لحم إضافي", priceDelta: "15.00" },
    ],
  });
  const modOrder: Order = {
    ...order,
    discountAmount: "0.00",
    subtotal: "230.00",
    serviceChargeAmount: null,
    deliveryFee: "0.00",
    vatAmount: "32.20",
    total: "262.20",
  };
  const input = { ...saleInput, order: modOrder, items: [modified], taxCodes: [taxCode(PRODUCT_A)], feeLines: undefined };

  it("prices the line from lineTotal, so the stored base price is not used", () => {
    // The buggy passthrough would have emitted 100.00 here, making
    // totalSale (230.00) != quantity * unitPrice (200.00).
    expect(buildReceipt(input).lines[0].unitPrice).toBe("115.00000");
  });

  it("satisfies totalSale = quantity * unitPrice on the emitted wire document", () => {
    const wire = toWireReceipt(buildReceipt(input), wireCtx);
    const line = (wire.itemData as Record<string, unknown>[])[0];
    expect((line.totalSale as { literal: string }).literal).toBe("230.00");
    expect((line.unitPrice as { literal: string }).literal).toBe("115.00000");
  });

  it("rejects a document whose unitPrice does not extend to its totalSale", () => {
    // The regression guard itself: hand-build the pre-fix shape and confirm
    // the wire boundary now refuses it.
    const doc = buildReceipt(input);
    const broken = { ...doc, lines: [{ ...doc.lines[0], unitPrice: "100.00" }] };
    expect(() => toWireReceipt(broken, wireCtx)).toThrow(/totalSale = quantity \* unitPrice/);
  });
});

describe("buildReceipt — fees as their own receipt lines", () => {
  it("emits a line per non-zero fee, quantity 1, classified from feeLines", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.lines).toHaveLength(4); // 2 products + service charge + delivery

    const service = doc.lines[2];
    expect(service).toMatchObject({ itemCode: "10008000", internalCode: "SVC", description: "Service charge", quantity: 1, lineTotal: "20.00" });

    const delivery = doc.lines[3];
    expect(delivery).toMatchObject({ itemCode: "10009000", internalCode: "DLV", description: "Delivery", quantity: 1, lineTotal: "25.00" });
  });

  it("keeps feesTotal as the semantic sum of both fee columns", () => {
    expect(buildReceipt(saleInput).feesTotal).toBe("45.00");
  });

  it("emits no fee line when both fee columns are zero", () => {
    const plain = { ...order, serviceChargeAmount: null, deliveryFee: "0.00", vatAmount: "28.00", total: "228.00" };
    const doc = buildReceipt({ ...saleInput, order: plain, feeLines: undefined });
    expect(doc.lines).toHaveLength(2);
    expect(doc.feesTotal).toBe("0.00");
  });

  it("throws FeeLineConfigMissingError naming the unconfigured service charge", () => {
    const input = { ...saleInput, feeLines: { delivery: feeLines.delivery } };
    expect(() => buildReceipt(input)).toThrow(FeeLineConfigMissingError);
    try {
      buildReceipt(input);
      expect.unreachable("buildReceipt should have thrown");
    } catch (err) {
      expect((err as FeeLineConfigMissingError).fee).toBe("serviceCharge");
      expect((err as FeeLineConfigMissingError).amount).toBe("20.00");
    }
  });

  it("throws FeeLineConfigMissingError naming the unconfigured delivery fee", () => {
    const input = { ...saleInput, feeLines: { serviceCharge: feeLines.serviceCharge } };
    try {
      buildReceipt(input);
      expect.unreachable("buildReceipt should have thrown");
    } catch (err) {
      expect((err as FeeLineConfigMissingError).fee).toBe("delivery");
      expect((err as FeeLineConfigMissingError).amount).toBe("25.00");
    }
  });
});

describe("buildReceipt — per-line VAT allocation", () => {
  const doc = buildReceipt(saleInput);
  const vatOf = (index: number) => doc.lines[index].taxes[0]?.amount ?? "0.00";

  it("splits orders.vatAmount across the taxed lines so the parts sum EXACTLY", () => {
    const summed = addDecimal("vat", ...doc.lines.flatMap((line) => line.taxes.map((tax) => tax.amount)), "0.00");
    expect(summed).toBe(order.vatAmount);
    expect(summed).toBe("30.80");
  });

  it("allocates proportionally to each line's net amount", () => {
    // Bases after the order discount is pushed down: 156.52 / 43.48 / 20.00,
    // summing to the taxable base 220.00; 14% of that is the stored 30.80.
    expect(vatOf(0)).toBe("21.91");
    expect(vatOf(1)).toBe("6.09");
    expect(vatOf(2)).toBe("2.80");
  });

  it("leaves the delivery line untaxed — computeOrderTotals adds it after VAT", () => {
    // ETA validates taxableItems[T1].amount as
    //   (t2 + netSale + TotalTaxableFees[T5-T12] + valueDifference + t3) * rate / 100,
    // i.e. netSale * rate / 100 for ServeOS (we emit no T2/T3/T5-T12 or
    // valueDifference), so a zero T1 entry on a non-zero netSale would be
    // rejected; the line carries none at all.
    expect(doc.lines[3].taxes).toEqual([]);
  });

  it("pushes the order-level discount onto the lines it actually reduced", () => {
    // 30.00 split over lineTotals 180.00 / 50.00 -> 23.48 / 6.52.
    expect(doc.lines[0].discountAmount).toBe("43.48"); // 20.00 line + 23.48 order
    expect(doc.lines[1].discountAmount).toBe("6.52");
    expect(doc.discountTotal).toBe("0.00"); // nothing left at receipt level
  });

  it("keeps the line net amounts summing to orders.subtotal", () => {
    const products = addDecimal("net", doc.lines[0].lineTotal, doc.lines[1].lineTotal);
    expect(products).toBe(order.subtotal);
  });

  it("reports the document taxTotals as the stored vatAmount", () => {
    expect(doc.taxTotals).toEqual([{ taxType: "T1", taxSubType: "V001", rate: "14", amount: "30.80" }]);
  });

  it("allocates odd cents by largest remainder and still sums exactly", () => {
    // Three lines of 10.00 / 20.00 / 0.01: an exact 14% split is impossible,
    // so the leftover cents go to the largest remainders.
    const oddItems = [
      item({ id: "o1", productId: PRODUCT_A, lineTotal: "10.00", unitBasePrice: "10.00" }),
      item({ id: "o2", productId: PRODUCT_A, lineTotal: "20.00", unitBasePrice: "20.00" }),
      item({ id: "o3", productId: PRODUCT_A, lineTotal: "0.01", unitBasePrice: "0.01" }),
    ];
    const oddOrder: Order = {
      ...order,
      discountAmount: "0.00",
      subtotal: "30.01",
      serviceChargeAmount: null,
      deliveryFee: "0.00",
      vatAmount: "4.20",
      total: "34.21",
    };
    const odd = buildReceipt({ ...saleInput, order: oddOrder, items: oddItems, taxCodes: [taxCode(PRODUCT_A)], feeLines: undefined });

    expect(odd.lines.map((line) => line.taxes[0]?.amount ?? "0.00")).toEqual(["1.40", "2.80", "0.00"]);
    expect(addDecimal("vat", ...odd.lines.flatMap((line) => line.taxes.map((t) => t.amount)), "0.00")).toBe("4.20");
  });

  it("allocates nothing when the order carries no VAT", () => {
    const noVat: Order = { ...order, vatAmount: "0.00", total: "245.00" };
    const doc0 = buildReceipt({ ...saleInput, order: noVat });
    expect(doc0.lines.every((line) => line.taxes.length === 0)).toBe(true);
    expect(doc0.taxTotals).toEqual([]);
  });
});

describe("buildReceipt — VAT-inclusive pricing", () => {
  // Same lines, but the stored total omits VAT on top: prices already contain
  // it, so total = subtotal + serviceCharge + delivery.
  const inclusiveOrder: Order = { ...order, vatAmount: "27.02", total: "245.00" };
  const doc = buildReceipt({ ...saleInput, order: inclusiveOrder });

  it("takes the allocated VAT back out of each line's net amount", () => {
    const grossProducts = addDecimal("gross", doc.lines[0].lineTotal, doc.lines[0].taxes[0].amount);
    expect(grossProducts).toBe("156.52"); // the base before VAT was separated
  });

  it("still sums the allocated VAT to the stored figure exactly", () => {
    expect(addDecimal("vat", ...doc.lines.flatMap((line) => line.taxes.map((t) => t.amount)), "0.00")).toBe("27.02");
  });

  it("derives a net unit price at the 5 decimals ETA permits", () => {
    // Main Calculations: "totalSale = quantity * unitPrice", and netSale must
    // be tax-exclusive — so a VAT-inclusive stored price cannot be reused.
    expect(doc.lines[0].unitPrice).not.toBe("100.00");
    expect(doc.lines[0].unitPrice.split(".")[1]).toHaveLength(5);
  });

  it("throws IrreconcilableOrderError when the stored figures match neither convention", () => {
    const broken: Order = { ...order, total: "999.99" };
    expect(() => buildReceipt({ ...saleInput, order: broken })).toThrow(IrreconcilableOrderError);
    try {
      buildReceipt({ ...saleInput, order: broken });
      expect.unreachable("buildReceipt should have thrown");
    } catch (err) {
      expect((err as IrreconcilableOrderError).message).toContain("999.99");
      expect((err as IrreconcilableOrderError).orderId).toBe(order.id);
    }
  });
});

describe("buildReceipt — payment method", () => {
  it("maps a cash tender to ETA's 'C'", () => {
    expect(buildReceipt(saleInput).paymentMethodCode).toBe("C");
  });

  it("maps a card tender to ETA's 'V' — the table's only card row", () => {
    const card = [payment({ id: "p1", method: "card", amount: "275.80" })];
    expect(buildReceipt({ ...saleInput, payments: card }).paymentMethodCode).toBe("V");
  });

  it("maps anything else to 'O' (Others)", () => {
    const other = [payment({ id: "p1", method: "other", amount: "275.80" })];
    expect(buildReceipt({ ...saleInput, payments: other }).paymentMethodCode).toBe("O");
  });

  it("resolves a split payment to the largest tender — v1.2 carries one code", () => {
    const split = [
      payment({ id: "p1", method: "cash", amount: "75.80" }),
      payment({ id: "p2", method: "card", amount: "200.00" }),
    ];
    expect(buildReceipt({ ...saleInput, payments: split }).paymentMethodCode).toBe("V");
  });

  it("falls back to orders.paymentMethod when there are no POS tenders", () => {
    expect(buildReceipt({ ...saleInput, payments: [] }).paymentMethodCode).toBe("C");
    const wallet = { ...order, paymentMethod: "vodafone_cash" as const };
    expect(buildReceipt({ ...saleInput, order: wallet, payments: [] }).paymentMethodCode).toBe("O");
  });
});

const refund: Refund = {
  id: "3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a",
  tenantId: order.tenantId,
  orderId: order.id,
  branchId: order.branchId,
  kind: "partial",
  reasonCode: "damaged",
  reasonText: null,
  totalAmount: "90.00",
  byUserId: "4a4a4a4a-4a4a-4a4a-8a4a-4a4a4a4a4a4a",
  authorizedByUserId: null,
  shiftId: null,
  clientRefundId: "cr-1",
  createdAt: new Date("2026-07-25T11:00:00.000Z"),
};

/** Only line A is returned, and only one of its two units. */
const refundLines: RefundLine[] = [
  {
    id: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a",
    tenantId: order.tenantId,
    refundId: refund.id,
    orderItemId: items[0].id,
    quantity: 1,
    amount: "90.00",
    restock: true,
  },
];

const refundInput: FiscalRefundInput = {
  parentUuid: "d".repeat(64),
  refund,
  lines: refundLines,
  items,
  taxCodes,
  previousUuid: "e".repeat(64),
  deviceSerial: "POS-001",
};

describe("buildReturnReceipt", () => {
  it("references the original sale receipt's uuid", () => {
    const doc = buildReturnReceipt(refundInput);
    expect(doc.docType).toBe("return_receipt");
    expect(doc.referenceUuid).toBe("d".repeat(64));
    expect(doc.previousUuid).toBe("e".repeat(64));
    expect(doc.uuid).toBeNull();
  });

  it("includes only the refunded lines, at the refunded quantity", () => {
    const doc = buildReturnReceipt(refundInput);
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0]).toMatchObject({
      itemCode: "10007020",
      internalCode: PRODUCT_A,
      description: "Shawarma Plate",
      quantity: 1,
      lineTotal: "90.00",
    });
  });

  it("carries POSITIVE amounts — Return Receipt v1.2 signals the return via receiptType 'r'", () => {
    // Return Receipt v1.2 describes totalSales/netAmount/totalAmount identically
    // to the sale receipt and defines no negative-amount convention; the return
    // is distinguished only by documentType.receiptType = "r" + referenceUUID.
    const doc = buildReturnReceipt(refundInput);
    expect(doc.total).toBe("90.00");
    expect(doc.subtotal).toBe("90.00");
    expect(doc.lines[0].lineTotal).toBe("90.00");
  });

  it("maps the refund total verbatim from refunds.totalAmount (F9)", () => {
    expect(buildReturnReceipt(refundInput).total).toBe(refund.totalAmount);
  });

  it("throws MissingTaxCodeError naming the product when a refunded line has no tax code", () => {
    const input = { ...refundInput, taxCodes: [taxCode(PRODUCT_B)] };
    try {
      buildReturnReceipt(input);
      expect.unreachable("buildReturnReceipt should have thrown");
    } catch (err) {
      expect((err as MissingTaxCodeError).productId).toBe(PRODUCT_A);
    }
  });

  it("throws EmptyReturnReceiptError for a header-only full refund", () => {
    // issueRefund inserts refund_lines only when the caller named them, so a
    // refund with no lines is reachable; itemData is Mandatory on the return.
    try {
      buildReturnReceipt({ ...refundInput, lines: [] });
      expect.unreachable("buildReturnReceipt should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EmptyReturnReceiptError);
      expect((err as EmptyReturnReceiptError).refundId).toBe(refund.id);
      expect((err as EmptyReturnReceiptError).message).toContain(refund.id);
    }
  });

  it("maps a REAL refund through the wire as a v1.2 return receipt", () => {
    const wire = toWireReceipt(buildReturnReceipt(refundInput), wireCtx);
    expect(wire.documentType).toEqual({ receiptType: "r", typeVersion: "1.2" });
    expect((wire.header as Record<string, unknown>).referenceUUID).toBe("d".repeat(64));

    const json = stringifyWire(wire);
    expect(json).toContain('"totalAmount":90.00');
    expect(json).toContain('"netAmount":90.00');
    // No VAT is reversed — refunds store no tax figures; see the builder's
    // JSDoc and addendum section 6.
    expect(json).not.toContain("taxTotals");
    expect(json).not.toContain("taxableItems");
  });

  it("throws when a refund line references an order item that was not supplied", () => {
    const orphan: RefundLine = { ...refundLines[0], orderItemId: "not-an-item" };
    expect(() => buildReturnReceipt({ ...refundInput, lines: [orphan] })).toThrow(/order item/i);
  });
});

/** Proves the two halves compose: a real order row through the builder, the
 *  v1.2 wire mapping, ETA's totals equation, the hash and the QR url. */
describe("buildReceipt -> finalizeReceipt", () => {
  it("satisfies ETA's totalAmount equation on the full discount + fees + VAT fixture", () => {
    // toWireReceipt throws EtaTotalsMismatchError unless
    // totalAmount = Sum(itemData.total) - Sum(extraReceiptDiscountData.amount).
    const doc = buildReceipt(saleInput);
    const wire = toWireReceipt(doc, wireCtx);
    const json = stringifyWire(wire);

    expect(json).toContain('"totalAmount":275.80');
    // The remaining published aggregates, all Sum() over the emitted lines:
    //   netAmount = Sum(netSale)                  156.52 + 43.48 + 20 + 25
    //   totalSales = Sum(totalSale)               200.00 + 50 + 20 + 25
    //   totalCommercialDiscount = Sum(discounts)   43.48 + 6.52
    expect(json).toContain('"netAmount":245.00');
    expect(json).toContain('"totalSales":295.00');
    expect(json).toContain('"totalCommercialDiscount":50.00');
    expect(json).toContain('"feesAmount":0.00');
    expect(json).toContain('"adjustment":0.00');
    expect(json).toContain('"paymentMethod":"C"');
    // 178.43 + 49.57 + 22.80 + 25.00 = 275.80, to the cent.
    expect(json).toContain('"total":178.43');
    expect(json).toContain('"total":25.00');
  });

  it("carries internalCode and the caller's receiptNumber onto the wire", () => {
    const wire = toWireReceipt(buildReceipt(saleInput), { ...wireCtx, receiptNumber: "SO-77" });
    expect((wire.header as Record<string, unknown>).receiptNumber).toBe("SO-77");
    expect((wire.itemData as Record<string, unknown>[])[0].internalCode).toBe(PRODUCT_A);
  });

  it("produces a hashable document whose totalAmount keeps its stored cents", () => {
    const doc = buildReceipt(saleInput);
    const out = finalizeReceipt(doc, wireCtx, { portalBase: "https://invoicing.eta.gov.eg" });

    expect(out.uuid).toMatch(/^[0-9a-f]{64}$/);
    // F9: the stored "275.80" reaches the wire as 275.80 — not 275.8.
    expect(stringifyWire(out.wire)).toContain('"totalAmount":275.80');
    expect(out.qrUrl).toBe(
      `https://invoicing.eta.gov.eg/receipts/search/${out.uuid}/share/2026-07-24T09:30:15Z#Total:275.80,IssuerRIN:200173707`,
    );
  });

  it("reconciles a VAT-inclusive sale too", () => {
    const inclusive: Order = { ...order, vatAmount: "27.02", total: "245.00" };
    const doc = buildReceipt({ ...saleInput, order: inclusive });
    expect(stringifyWire(toWireReceipt(doc, wireCtx))).toContain('"totalAmount":245.00');
  });
});

describe("wire-boundary fail-closed guards", () => {
  it("rejects a T4-classified line — ETA SUBTRACTS T4 in the line-total equation", () => {
    const t4 = { ...saleInput, taxCodes: [taxCode(PRODUCT_A, { taxType: "T4" }), taxCode(PRODUCT_B)] };
    expect(() => toWireReceipt(buildReceipt(t4), wireCtx)).toThrow(UnsupportedTaxTypeError);
  });

  it("accepts the additive tax types either side of T4", () => {
    for (const taxType of ["T3", "T5"]) {
      // Every line has to agree, fee lines included, or the document's own
      // taxTotals would no longer match the sum of its line taxes.
      const codes = [taxCode(PRODUCT_A, { taxType }), taxCode(PRODUCT_B, { taxType })];
      const fees = {
        serviceCharge: feeConfig({ taxType }),
        delivery: feeConfig({ taxType, itemCode: "10009000", description: "Delivery", internalCode: "DLV" }),
      };
      expect(() => toWireReceipt(buildReceipt({ ...saleInput, taxCodes: codes, feeLines: fees }), wireCtx)).not.toThrow();
    }
  });

  it("requires a buyer id at or above ETA's 150,000 threshold for a P-type buyer", () => {
    const big = { ...order, subtotal: "150000.00", serviceChargeAmount: null, deliveryFee: "0.00", discountAmount: "0.00", vatAmount: "0.00", total: "150000.00" };
    const bigItems = [item({ id: "b1", productId: PRODUCT_A, lineTotal: "150000.00", unitBasePrice: "150000.00" })];
    const doc = buildReceipt({ ...saleInput, order: big, items: bigItems, taxCodes: [taxCode(PRODUCT_A)], feeLines: undefined });
    expect(() => toWireReceipt(doc, wireCtx)).toThrow(BuyerIdRequiredError);
  });

  it("allows the same receipt one piastre below the threshold", () => {
    const under = { ...order, subtotal: "149999.99", serviceChargeAmount: null, deliveryFee: "0.00", discountAmount: "0.00", vatAmount: "0.00", total: "149999.99" };
    const underItems = [item({ id: "u1", productId: PRODUCT_A, lineTotal: "149999.99", unitBasePrice: "149999.99" })];
    const doc = buildReceipt({ ...saleInput, order: under, items: underItems, taxCodes: [taxCode(PRODUCT_A)], feeLines: undefined });
    expect(() => toWireReceipt(doc, wireCtx)).not.toThrow();
  });

  it("allows an identified buyer above the threshold", () => {
    const big = { ...order, subtotal: "150000.00", serviceChargeAmount: null, deliveryFee: "0.00", discountAmount: "0.00", vatAmount: "0.00", total: "150000.00" };
    const bigItems = [item({ id: "b1", productId: PRODUCT_A, lineTotal: "150000.00", unitBasePrice: "150000.00" })];
    const doc = buildReceipt({ ...saleInput, order: big, items: bigItems, taxCodes: [taxCode(PRODUCT_A)], feeLines: undefined });
    const identified = { ...doc, buyer: { type: "P" as const, id: "29801011234567", name: "A Customer" } };
    expect(() => toWireReceipt(identified, wireCtx)).not.toThrow();
  });

  it("honours a caller-supplied threshold", () => {
    const doc = buildReceipt(saleInput); // total 275.80
    expect(() => toWireReceipt(doc, { ...wireCtx, buyerIdThreshold: "100.00" })).toThrow(BuyerIdRequiredError);
  });
});

describe("EtaFiscalProvider", () => {
  it("delegates buildReceipt to the pure builder", () => {
    const doc: FiscalDocument = new EtaFiscalProvider().buildReceipt(saleInput);
    expect(doc).toEqual(buildReceipt(saleInput));
  });

  it("delegates buildReturnReceipt to the pure builder", () => {
    const doc: FiscalDocument = new EtaFiscalProvider().buildReturnReceipt(refundInput);
    expect(doc).toEqual(buildReturnReceipt(refundInput));
  });

  it("still throws for submit/poll — Task 3b wires the HTTP calls", async () => {
    const eta = new EtaFiscalProvider();
    await expect(eta.submit({} as FiscalDocument, {} as EtaConfig)).rejects.toThrow("not implemented");
    await expect(eta.poll("submission-uuid", {} as EtaConfig)).rejects.toThrow("not implemented");
  });
});
