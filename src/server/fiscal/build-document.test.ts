import { describe, it, expect } from "vitest";
import { buildReceipt, buildReturnReceipt, MissingTaxCodeError } from "./build-document";
import { EtaFiscalProvider } from "./eta-provider";
import { finalizeReceipt, stringifyWire } from "./serialize";
import { UnrepresentableFeesError, type WireContext } from "./eta-wire";
import type { FiscalSaleInput, FiscalRefundInput, FiscalDocument, EtaConfig } from "./provider";
import type { ProductTaxCode } from "./schema";
import type { Order, OrderItem } from "@/server/ordering/schema";
import type { Refund, RefundLine } from "@/server/pos/refund-schema";

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

const items: OrderItem[] = [
  {
    id: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
    tenantId: order.tenantId,
    orderId: order.id,
    productId: PRODUCT_A,
    variantId: null,
    variantNameEn: null,
    variantNameAr: null,
    nameEn: "Shawarma Plate",
    nameAr: "طبق شاورما",
    unitBasePrice: "100.00",
    quantity: 2,
    lineTotal: "180.00",
    discountAmount: "20.00",
    selectedModifiers: [],
    dimensions: null,
  },
  {
    id: "2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a",
    tenantId: order.tenantId,
    orderId: order.id,
    productId: PRODUCT_B,
    variantId: null,
    variantNameEn: null,
    variantNameAr: null,
    nameEn: "Mint Lemonade",
    nameAr: "ليمون بالنعناع",
    unitBasePrice: "50.00",
    quantity: 1,
    lineTotal: "50.00",
    discountAmount: "0.00",
    selectedModifiers: [],
    dimensions: null,
  },
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

const saleInput: FiscalSaleInput = {
  order,
  items,
  taxCodes,
  previousUuid: "c".repeat(64),
  deviceSerial: "POS-001",
};

describe("buildReceipt", () => {
  it("builds an e_receipt with a null uuid and the supplied chain head", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.docType).toBe("e_receipt");
    // The uuid is computed later, from the serialized WIRE document (finalizeReceipt).
    expect(doc.uuid).toBeNull();
    expect(doc.previousUuid).toBe("c".repeat(64));
    expect(doc.referenceUuid).toBeNull();
    expect(doc.referenceOldUuid).toBeNull();
    expect(doc.currency).toBe("EGP");
  });

  it("defaults the buyer to an unidentified natural person", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.buyer).toEqual({ type: "P" });
  });

  it("maps each line's fiscal codes from that product's ProductTaxCode", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0]).toMatchObject({
      itemCode: "10007020",
      codeSource: "gs1",
      taxType: "T1",
      taxSubType: "V001",
      unitType: "EA",
      description: "Shawarma Plate",
      quantity: 2,
    });
    expect(doc.lines[1]).toMatchObject({
      itemCode: "EG-2001",
      codeSource: "egs",
      unitType: "PCE",
      description: "Mint Lemonade",
      quantity: 1,
    });
  });

  it("maps line money verbatim from the order_items row (F9 — no recomputation)", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.lines[0].unitPrice).toBe("100.00");
    expect(doc.lines[0].discountAmount).toBe("20.00");
    expect(doc.lines[0].lineTotal).toBe("180.00");
    // ServeOS stores VAT only at the order level — there is no per-line split
    // to map, so line taxes stay empty and the document carries taxTotals.
    expect(doc.lines[0].taxes).toEqual([]);
  });

  it("maps the document total verbatim from orders.total, to the cent (F9)", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.total).toBe(order.total);
    expect(doc.total).toBe("275.80");
    expect(doc.subtotal).toBe("200.00");
    expect(doc.discountTotal).toBe("30.00");
  });

  it("maps taxTotals from the order's VAT snapshot", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.taxTotals).toEqual([
      { taxType: "T1", taxSubType: "V001", rate: "14", amount: "30.80" },
    ]);
  });

  it("sums serviceChargeAmount + deliveryFee into the single ETA fees slot", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.feesTotal).toBe("45.00");
  });

  it("treats a null serviceChargeAmount as zero", () => {
    const doc = buildReceipt({ ...saleInput, order: { ...order, serviceChargeAmount: null } });
    expect(doc.feesTotal).toBe("25.00");
  });

  it("issues at the order's placedAt as second-precision ISO UTC", () => {
    const doc = buildReceipt(saleInput);
    expect(doc.issuedAt).toBe("2026-07-24T09:30:15Z");
  });

  it("throws MissingTaxCodeError naming the product when a line has no tax code", () => {
    const input = { ...saleInput, taxCodes: [taxCode(PRODUCT_A)] };
    expect(() => buildReceipt(input)).toThrow(MissingTaxCodeError);
    try {
      buildReceipt(input);
      expect.unreachable("buildReceipt should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTaxCodeError);
      expect((err as MissingTaxCodeError).productId).toBe(PRODUCT_B);
      expect((err as MissingTaxCodeError).message).toContain(PRODUCT_B);
    }
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
      description: "Shawarma Plate",
      quantity: 1,
      unitPrice: "100.00",
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
    const doc = buildReturnReceipt(refundInput);
    expect(doc.total).toBe(refund.totalAmount);
  });

  it("throws MissingTaxCodeError naming the product when a refunded line has no tax code", () => {
    const input = { ...refundInput, taxCodes: [taxCode(PRODUCT_B)] };
    expect(() => buildReturnReceipt(input)).toThrow(MissingTaxCodeError);
    try {
      buildReturnReceipt(input);
      expect.unreachable("buildReturnReceipt should have thrown");
    } catch (err) {
      expect((err as MissingTaxCodeError).productId).toBe(PRODUCT_A);
    }
  });

  it("throws when a refund line references an order item that was not supplied", () => {
    const orphan: RefundLine = { ...refundLines[0], orderItemId: "not-an-item" };
    expect(() => buildReturnReceipt({ ...refundInput, lines: [orphan] })).toThrow(/order item/i);
  });
});

/** Proves the two halves compose: a real order row through the builder, the
 *  v1.2 wire mapping, the hash and the QR url. */
describe("buildReceipt -> finalizeReceipt", () => {
  const wireCtx: WireContext = {
    rin: "200173707",
    sellerName: "ABC Corp",
    branchCode: "ABC",
    branchAddress: { country: "EG", governate: "Giza Governorate", regionCity: "Dokki", street: "17 Nabil Al Wakad", buildingNumber: "17" },
    deviceSerial: "POS-001",
    activityCode: "5610",
    receiptNumber: "1042",
    paymentMethodCode: "C",
  };

  it("produces a hashable v1.2 document whose totalAmount keeps its stored cents", () => {
    // No service charge, no delivery: total = 230.00 - 30.00 order discount
    // + 14% VAT on 200.00 = 228.00.
    const noFees: Order = { ...order, serviceChargeAmount: null, deliveryFee: "0.00", vatAmount: "28.00", total: "228.00" };
    const doc = buildReceipt({ ...saleInput, order: noFees });
    const out = finalizeReceipt(doc, wireCtx, { portalBase: "https://invoicing.eta.gov.eg" });

    expect(out.uuid).toMatch(/^[0-9a-f]{64}$/);
    // F9: the stored "228.00" reaches the wire as 228.00 — not 228, not a float artefact.
    expect(stringifyWire(out.wire)).toContain('"totalAmount":228.00');
    expect(out.qrUrl).toBe(
      `https://invoicing.eta.gov.eg/receipts/search/${out.uuid}/share/2026-07-24T09:30:15Z#Total:228.00,IssuerRIN:200173707`,
    );
  });

  it("refuses a sale carrying a service charge or delivery fee", () => {
    // Receipt v1.2: "feesAmount and adjustment fields are reserved for future
    // use, both accept only zero values" — ETA has nowhere to put ServeOS's
    // service charge + delivery fee, so the document is refused rather than
    // silently sent with the money dropped. Task 3b/6 must issue fees as
    // their own itemData lines.
    const doc = buildReceipt(saleInput);
    expect(doc.feesTotal).toBe("45.00");
    expect(() => finalizeReceipt(doc, wireCtx, { portalBase: "https://invoicing.eta.gov.eg" })).toThrow(UnrepresentableFeesError);
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
