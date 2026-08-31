import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSerialize, stringifyWire, computeReceiptUuid } from "./serialize";
import { finalizeReceipt, type WireContext } from "./eta-wire";
import { WireDecimal } from "./decimal";
import { parseWire } from "./parse-wire";
import type { FiscalDocument } from "./provider";

const FIXTURES = join(__dirname, "__fixtures__");

const WIRE_CONTEXT: WireContext = {
  rin: "200173707",
  sellerName: "Fiscal Co",
  branchCode: "0",
  branchAddress: {
    country: "EG", governate: "Cairo", regionCity: "Nasr City",
    street: 'Test "Quoted" Street 12', buildingNumber: "12",
  },
  deviceSerial: "POS-001",
  activityCode: "5610",
  receiptNumber: "1001",
};

/** A receipt with a trailing-zero total, a discounted line and a tax line —
 *  the shapes whose literals a lossy round trip would flatten. */
const DOCUMENT: FiscalDocument = {
  docType: "e_receipt",
  uuid: null,
  previousUuid: "",
  referenceUuid: null,
  referenceOldUuid: null,
  buyer: { type: "P" },
  lines: [{
    itemCode: "1234567890123",
    internalCode: "prod-1",
    codeSource: "gs1",
    taxType: "T1",
    taxSubType: "V009",
    unitType: "EA",
    description: "Margherita",
    quantity: 2,
    // totalSale (lineTotal + discount = 100.00) / quantity, per Main Calculations.
    unitPrice: "50.00000",
    discountAmount: "10.00",
    taxes: [{ taxType: "T1", taxSubType: "V009", rate: "14.00", amount: "12.60" }],
    lineTotal: "90.00",
  }],
  subtotal: "100.00",
  discountTotal: "0.00",
  feesTotal: "0.00",
  taxTotals: [{ taxType: "T1", taxSubType: "V009", rate: "14.00", amount: "12.60" }],
  total: "102.60",
  paymentMethodCode: "C",
  currency: "EGP",
  issuedAt: "2026-08-31T09:00:00Z",
};

const finalized = finalizeReceipt(DOCUMENT, WIRE_CONTEXT, { portalBase: "https://preprod.invoicing.eta.gov.eg" });
const text = stringifyWire(finalized.wire);

describe("parseWire", () => {
  it("round-trips a finalized receipt back to the exact transmitted bytes", () => {
    // The whole reason this module exists: what comes out of the database must
    // re-serialize into the bytes that were hashed.
    expect(stringifyWire(parseWire(text))).toBe(text);
  });

  it("preserves the uuid across the round trip", () => {
    expect(computeReceiptUuid(parseWire(text))).toBe(finalized.uuid);
  });

  it("keeps decimal literals, trailing zeros and all", () => {
    const wire = parseWire(text);
    expect(wire.totalAmount).toBeInstanceOf(WireDecimal);
    expect((wire.totalAmount as WireDecimal).literal).toBe("102.60");
    // 5-decimal unit prices are the tightest case ETA permits.
    const item = (wire.itemData as Record<string, unknown>[])[0];
    expect((item.unitPrice as WireDecimal).literal).toBe("50.00000");
  });

  it("keeps property order, which IS part of the fiscal identity", () => {
    expect(Object.keys(parseWire(text))).toEqual(Object.keys(finalized.wire));
    const header = parseWire(text).header as Record<string, unknown>;
    expect(Object.keys(header)).toEqual(Object.keys(finalized.wire.header as Record<string, unknown>));
  });

  it("leaves digits, braces and escaped quotes inside strings alone", () => {
    const wire = parseWire(text);
    const seller = wire.seller as Record<string, unknown>;
    const address = seller.branchAddress as Record<string, unknown>;
    expect(address.street).toBe('Test "Quoted" Street 12');
    expect(address.buildingNumber).toBe("12"); // a quoted numeral stays a string
  });

  it("reproduces ETA's own golden vector — parsed by this module, serialized by ours", () => {
    // An independent check against the Authority's published example: if the
    // number-tagging scan mangled anything, ~5.7KB of canonical output would
    // not match byte for byte. See __fixtures__/README.md for provenance.
    const raw = readFileSync(join(FIXTURES, "one-doc.json"), "utf8");
    const expected = readFileSync(join(FIXTURES, "one-doc-serialized.json.txt"), "utf8").trim();
    expect(canonicalSerialize(parseWire(raw))).toBe(expected);
  });

  it("refuses a stored value that is not a JSON object", () => {
    expect(() => parseWire("[1,2]")).toThrow(/not a JSON object/);
  });
});
