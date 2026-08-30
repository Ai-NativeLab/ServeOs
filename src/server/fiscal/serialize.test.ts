import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSerialize, stringifyWire, computeReceiptUuid, buildQrUrl, finalizeReceipt } from "./serialize";
import { toWireReceipt, dec, EtaTotalsMismatchError, type WireContext } from "./eta-wire";
import type { FiscalDocument } from "./provider";

/**
 * GOLDEN VECTORS — copied verbatim from the Egyptian Tax Authority's own
 * published worked example, so these assertions are ETA's output, not ours:
 *   source document : https://sdk.invoicing.eta.gov.eg/files/one-doc.json
 *   canonical output: https://sdk.invoicing.eta.gov.eg/files/one-doc-serialized.json.txt
 *   algorithm       : https://sdk.invoicing.eta.gov.eg/document-serialization-approach/
 *
 * The algorithm is a straight recursive concatenation, so every whole
 * sub-object of the source maps to a contiguous slice of the published output
 * — each fixture below is one such sub-object paired with its published slice.
 */
const FIXTURES = join(__dirname, "__fixtures__");

/**
 * Reads ETA's example document while keeping every number's EXACT source text.
 *
 * `JSON.parse` would turn `10.50` into the JS number `10.5`, destroying the
 * one property this vector exists to prove — that values are serialized "just
 * like those are in the input document". So numeric literals are tagged as
 * strings first, then revived as `WireDecimal`s. If the tagging ever mangled
 * the document the byte-exact assertion below would fail immediately, so the
 * test verifies its own fixture handling.
 */
function readExampleDocument(): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURES, "one-doc.json"), "utf8");
  const tagged = raw.replace(/(?<=[:[,]\s*)(-?\d+(?:\.\d+)?)(?=\s*[,\]}])/g, '"#DEC#$1"');
  const revive = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(revive);
    if (typeof value === "string") return value.startsWith("#DEC#") ? dec(value.slice(5)) : value;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, revive(v)]));
    }
    return value;
  };
  return revive(JSON.parse(tagged)) as Record<string, unknown>;
}

describe("canonicalSerialize — ETA's full published golden vector", () => {
  it("reproduces one-doc-serialized.json.txt byte for byte", () => {
    // The strongest check available: ETA's own input document against ETA's
    // own canonical output, ~5.7KB covering 2 invoice lines x 20 taxableItems,
    // nested objects, empty strings and trailing-zero decimals.
    // See __fixtures__/README.md for provenance.
    const expected = readFileSync(join(FIXTURES, "one-doc-serialized.json.txt"), "utf8").trim();
    expect(canonicalSerialize(readExampleDocument())).toBe(expected);
  });

  it("keeps trailing zeros through the fixture reader, proving the vector is meaningful", () => {
    const doc = readExampleDocument() as { delivery: Record<string, unknown> };
    expect((doc.delivery.grossWeight as { literal: string }).literal).toBe("10.50");
  });
});

describe("canonicalSerialize — ETA's published worked example", () => {
  it("serializes the example's `issuer` object exactly (nesting + invariant uppercase)", () => {
    const issuer = {
      issuer: {
        address: {
          branchID: "1",
          country: "EG",
          governate: "Cairo",
          regionCity: "Nasr City",
          street: "580 Clementina Key",
          buildingNumber: "Bldg. 0",
          postalCode: "68030",
          floor: "1",
          room: "123",
          landmark: "7660 Melody Trail",
          additionalInformation: "beside Townhall",
        },
        type: "B",
        id: "113317713",
        name: "Issuer Company",
      },
    };
    expect(canonicalSerialize(issuer)).toBe(
      '"ISSUER""ADDRESS""BRANCHID""1""COUNTRY""EG""GOVERNATE""Cairo""REGIONCITY""Nasr City""STREET""580 Clementina Key""BUILDINGNUMBER""Bldg. 0""POSTALCODE""68030""FLOOR""1""ROOM""123""LANDMARK""7660 Melody Trail""ADDITIONALINFORMATION""beside Townhall""TYPE""B""ID""113317713""NAME""Issuer Company"',
    );
  });

  it("serializes the example's `payment` object exactly (empty strings keep their property)", () => {
    // Rule pinned: an empty-string value is still emitted as NAME + "" — see
    // BANKACCOUNTIBAN/SWIFTCODE below. This is what makes the "empty uuid"
    // rule in computeReceiptUuid observable in the hashed text.
    const payment = {
      payment: {
        bankName: "SomeValue",
        bankAddress: "SomeValue",
        bankAccountNo: "SomeValue",
        bankAccountIBAN: "",
        swiftCode: "",
        terms: "SomeValue",
      },
    };
    expect(canonicalSerialize(payment)).toBe(
      '"PAYMENT""BANKNAME""SomeValue""BANKADDRESS""SomeValue""BANKACCOUNTNO""SomeValue""BANKACCOUNTIBAN""""SWIFTCODE""""TERMS""SomeValue"',
    );
  });

  it("serializes the example's `delivery` object exactly (decimal literals verbatim)", () => {
    // Rule pinned: "All property values are taken without any processing" —
    // 10.50 must serialize as "10.50", NOT "10.5". A JS number cannot carry
    // that trailing zero, which is why decimals go through dec().
    const delivery = {
      delivery: {
        approach: "SomeValue",
        packaging: "SomeValue",
        dateValidity: "2020-09-28T09:30:10Z",
        exportPort: "SomeValue",
        countryOfOrigin: "EG",
        grossWeight: dec("10.50"),
        netWeight: dec("20.50"),
        terms: "SomeValue",
      },
    };
    expect(canonicalSerialize(delivery)).toBe(
      '"DELIVERY""APPROACH""SomeValue""PACKAGING""SomeValue""DATEVALIDITY""2020-09-28T09:30:10Z""EXPORTPORT""SomeValue""COUNTRYOFORIGIN""EG""GROSSWEIGHT""10.50""NETWEIGHT""20.50""TERMS""SomeValue"',
    );
  });

  it("serializes the example's `taxTotals` array exactly (name once, then again per element)", () => {
    // Rule pinned: "entire array serialization result is prefixed with the
    // array property name and every array element is preceded with the array
    // property name" — hence TAXTOTALS appears 1 + n times for n elements.
    const taxTotals = {
      taxTotals: [
        { taxType: "T1", amount: dec("477.54") },
        { taxType: "T2", amount: dec("365.47") },
      ],
    };
    expect(canonicalSerialize(taxTotals)).toBe(
      '"TAXTOTALS""TAXTOTALS""TAXTYPE""T1""AMOUNT""477.54""TAXTOTALS""TAXTYPE""T2""AMOUNT""365.47"',
    );
  });
});

describe("canonicalSerialize — rules the worked example does not exercise", () => {
  it("emits the array property name alone for an empty array", () => {
    expect(canonicalSerialize({ taxableItems: [] })).toBe('"TAXABLEITEMS"');
  });

  it("uppercases property names without applying a locale (culture invariant)", () => {
    // Turkish-locale uppercasing would turn "i" into "İ"; toUpperCase must not.
    expect(canonicalSerialize({ internalCode: "x" })).toBe('"INTERNALCODE""x"');
  });

  it("preserves document property order — the algorithm never sorts", () => {
    expect(canonicalSerialize({ b: "1", a: "2" })).toBe('"B""1""A""2"');
  });

  it("does not escape double quotes in JSON values (escaping is XML-only)", () => {
    expect(canonicalSerialize({ description: 'a "b" c' })).toBe('"DESCRIPTION""a "b" c"');
  });

  it("rejects null and undefined — ETA publishes no null rule, so callers must omit", () => {
    expect(() => canonicalSerialize({ taxSubType: null })).toThrow(/null/i);
    expect(() => canonicalSerialize({ taxSubType: undefined })).toThrow(/null/i);
  });

  it("serializes a nested object inside an array element (two-level fixture)", () => {
    const wire = {
      itemData: [
        { itemCode: "A1", unitValue: { amountEGP: dec("18.94"), currencySold: "EGP" }, quantity: 3 },
      ],
    };
    expect(canonicalSerialize(wire)).toBe(
      '"ITEMDATA""ITEMDATA""ITEMCODE""A1""UNITVALUE""AMOUNTEGP""18.94""CURRENCYSOLD""EGP""QUANTITY""3"',
    );
  });
});

describe("stringifyWire", () => {
  it("emits decimals as unquoted JSON numbers with their exact literal text", () => {
    // F9: "115.00" must reach ETA as 115.00 — not "115.00", not 115, and never
    // a float round-trip that could surface 115.00000000001.
    const json = stringifyWire({ totalAmount: dec("115.00"), currency: "EGP" });
    expect(json).toBe('{"totalAmount":115.00,"currency":"EGP"}');
    expect(JSON.parse(json).totalAmount).toBe(115);
  });

  it("escapes strings the way JSON requires", () => {
    expect(stringifyWire({ description: 'a "b"' })).toBe('{"description":"a \\"b\\""}');
  });

  it("round-trips the same literals the canonical serializer hashes", () => {
    const wire = { totalAmount: dec("275.80"), lines: [{ total: dec("180.00") }] };
    expect(stringifyWire(wire)).toContain("275.80");
    expect(canonicalSerialize(wire)).toContain('"TOTALAMOUNT""275.80"');
  });
});

/** A minimal but complete v1.2 wire context — every field ETA marks Mandatory
 *  that ServeOS's own rows cannot supply. */
const ctx: WireContext = {
  rin: "200173707",
  sellerName: "ABC Corp",
  branchCode: "ABC",
  branchAddress: {
    country: "EG",
    governate: "Giza Governorate",
    regionCity: "Dokki",
    street: "17 Nabil Al Wakad",
    buildingNumber: "17",
  },
  deviceSerial: "POS-001",
  activityCode: "5610",
  receiptNumber: "1042",
};

const doc: FiscalDocument = {
  docType: "e_receipt",
  uuid: null,
  previousUuid: "c".repeat(64),
  referenceUuid: null,
  referenceOldUuid: null,
  buyer: { type: "P" },
  lines: [
    {
      itemCode: "10007020",
      codeSource: "gs1",
      taxType: "T1",
      taxSubType: "V001",
      unitType: "EA",
      description: "Shawarma Plate",
      quantity: 2,
      unitPrice: "85.00", // 2 x 85.00 = 170.00 = netSale 150.00 + discount 20.00
      discountAmount: "20.00",
      taxes: [{ taxType: "T1", taxSubType: "V001", rate: "14", amount: "21.00" }],
      lineTotal: "150.00",
    },
  ],
  subtotal: "150.00",
  discountTotal: "0.00",
  feesTotal: "0.00",
  taxTotals: [{ taxType: "T1", taxSubType: "V001", rate: "14", amount: "21.00" }],
  total: "171.00",
  paymentMethodCode: "C",
  currency: "EGP",
  issuedAt: "2026-07-24T09:30:15Z",
};

describe("toWireReceipt", () => {
  it("emits the v1.2 sale receipt document type", () => {
    const wire = toWireReceipt(doc, ctx) as { documentType: Record<string, string> };
    expect(wire.documentType).toEqual({ receiptType: "s", typeVersion: "1.2" });
  });

  it("emits the v1.2 return receipt document type and the parent's referenceUUID", () => {
    const ret = { ...doc, docType: "return_receipt" as const, referenceUuid: "d".repeat(64) };
    const wire = toWireReceipt(ret, ctx) as {
      documentType: Record<string, string>;
      header: Record<string, unknown>;
    };
    expect(wire.documentType).toEqual({ receiptType: "r", typeVersion: "1.2" });
    expect(wire.header.referenceUUID).toBe("d".repeat(64));
  });

  it("carries a blank uuid until finalizeReceipt computes it", () => {
    const wire = toWireReceipt(doc, ctx) as { header: Record<string, unknown> };
    expect(wire.header.uuid).toBe("");
    expect(wire.header.previousUUID).toBe("c".repeat(64));
  });

  it("maps totalAmount verbatim from the document total (F9)", () => {
    const wire = toWireReceipt(doc, ctx) as Record<string, unknown>;
    expect(stringifyWire(wire)).toContain('"totalAmount":171.00');
  });

  it("emits the payment method code the builder resolved", () => {
    expect(stringifyWire(toWireReceipt(doc, ctx))).toContain('"paymentMethod":"C"');
  });

  it("omits optional fields rather than emitting null", () => {
    const json = stringifyWire(toWireReceipt(doc, ctx));
    expect(json).not.toContain("null");
    expect(json).not.toContain("syndicateLicenseNumber");
  });

  it("always emits zero feesAmount and adjustment, whatever the document carries", () => {
    // Receipt v1.2: "feesAmount and adjustment fields are reserved for future
    // use, both accept only zero values" — fees ship as itemData lines instead.
    const json = stringifyWire(toWireReceipt({ ...doc, feesTotal: "45.00" }, ctx));
    expect(json).toContain('"feesAmount":0.00');
    expect(json).toContain('"adjustment":0.00');
  });

  it("refuses a document that breaks ETA's totalAmount equation", () => {
    expect(() => toWireReceipt({ ...doc, total: "999.99" }, ctx)).toThrow(EtaTotalsMismatchError);
  });

  it("refuses a document whose taxTotals disagree with its line taxes", () => {
    const skewed = { ...doc, taxTotals: [{ taxType: "T1", taxSubType: "V001", rate: "14", amount: "99.00" }] };
    expect(() => toWireReceipt(skewed, ctx)).toThrow(EtaTotalsMismatchError);
  });
});

describe("computeReceiptUuid", () => {
  const wire = toWireReceipt(doc, ctx);

  it("is a 64-character lowercase hex SHA-256", () => {
    expect(computeReceiptUuid(wire)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same wire document", () => {
    expect(computeReceiptUuid(wire)).toBe(computeReceiptUuid(toWireReceipt(doc, ctx)));
  });

  it("ignores any uuid already present — the uuid never hashes itself", () => {
    const withUuid = toWireReceipt(doc, ctx);
    (withUuid.header as Record<string, unknown>).uuid = "f".repeat(64);
    expect(computeReceiptUuid(withUuid)).toBe(computeReceiptUuid(wire));
  });

  it("hashes the uuid property as present-but-empty, per the FAQ's wording", () => {
    // "Make sure receipt object has empty receipt UUID which is being
    // generated" + "flatten all its properties" => the key stays, blank.
    expect(canonicalSerialize(wire)).toContain('"UUID"""');
  });

  it("changes when previousUUID changes — the per-device chain is tamper-evident", () => {
    const other = toWireReceipt({ ...doc, previousUuid: "9".repeat(64) }, ctx);
    expect(computeReceiptUuid(other)).not.toBe(computeReceiptUuid(wire));
  });

  it("changes when any money field changes", () => {
    // Moved coherently: the wire mapping refuses a document whose lines no
    // longer add up to its total, so one cent moves on the line AND the total.
    const lines = [{ ...doc.lines[0], lineTotal: "150.01", unitPrice: "85.005" }];
    const other = toWireReceipt({ ...doc, lines, subtotal: "150.01", total: "171.01" }, ctx);
    expect(computeReceiptUuid(other)).not.toBe(computeReceiptUuid(wire));
  });

  it("changes when a line's tax code changes", () => {
    const lines = [{ ...doc.lines[0], itemCode: "10007021" }];
    expect(computeReceiptUuid(toWireReceipt({ ...doc, lines }, ctx))).not.toBe(computeReceiptUuid(wire));
  });
});

describe("buildQrUrl", () => {
  it("reproduces the FAQ's own published example exactly", () => {
    // https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/ — "Example of
    // formated QR Code Content".
    expect(
      buildQrUrl({
        portalBase: "http://invoicing.eta.gov.eg",
        uuid: "68e656b251e67e8358bef8483ab0d51c6619f3e7a1a9f0e75838d41ff368f320",
        dateUtc: "2022-02-19T02:00Z",
        total: "1000.000",
        rin: "674859545",
      }),
    ).toBe(
      "http://invoicing.eta.gov.eg/receipts/search/68e656b251e67e8358bef8483ab0d51c6619f3e7a1a9f0e75838d41ff368f320/share/2022-02-19T02:00Z#Total:1000.000,IssuerRIN:674859545",
    );
  });

  it("tolerates a portal base with a trailing slash", () => {
    expect(
      buildQrUrl({ portalBase: "https://invoicing.eta.gov.eg/", uuid: "a".repeat(64), dateUtc: "2026-07-24T09:30:15Z", total: "275.80", rin: "200173707" }),
    ).toBe(
      `https://invoicing.eta.gov.eg/receipts/search/${"a".repeat(64)}/share/2026-07-24T09:30:15Z#Total:275.80,IssuerRIN:200173707`,
    );
  });
});

describe("finalizeReceipt", () => {
  const out = finalizeReceipt(doc, ctx, { portalBase: "https://invoicing.eta.gov.eg" });

  it("writes the computed uuid into the wire document", () => {
    expect(out.uuid).toMatch(/^[0-9a-f]{64}$/);
    expect((out.wire as { header: Record<string, unknown> }).header.uuid).toBe(out.uuid);
  });

  it("computes the same uuid the standalone helper does", () => {
    expect(out.uuid).toBe(computeReceiptUuid(toWireReceipt(doc, ctx)));
  });

  it("embeds that same uuid, the issuance datetime and the RIN in the QR url", () => {
    expect(out.qrUrl).toBe(
      `https://invoicing.eta.gov.eg/receipts/search/${out.uuid}/share/2026-07-24T09:30:15Z#Total:171.00,IssuerRIN:200173707`,
    );
  });

  it("is pure — the same inputs produce the same uuid every time", () => {
    expect(finalizeReceipt(doc, ctx, { portalBase: "https://invoicing.eta.gov.eg" }).uuid).toBe(out.uuid);
  });

  it("carries referenceOldUUID through for a corrected resubmission", () => {
    const corrected = { ...doc, referenceOldUuid: "b".repeat(64) };
    const res = finalizeReceipt(corrected, ctx, { portalBase: "https://invoicing.eta.gov.eg" });
    expect((res.wire as { header: Record<string, unknown> }).header.referenceOldUUID).toBe("b".repeat(64));
    // Resubmission keeps the SAME previousUUID but must land a NEW uuid.
    expect(res.uuid).not.toBe(out.uuid);
  });
});
