import { describe, expect, it } from "vitest";
import {
  BUYER_RIN_RE,
  EMPTY_BUYER_DRAFT,
  OPTIONAL_BUYER_FIELDS,
  REQUIRED_BUYER_FIELDS,
  buildPosSaleBuyer,
  validateBuyerDraft,
  type BuyerDraft,
} from "./buyer";

/**
 * The till's half of the B2B capture. Everything here is pure, and it is the
 * ONLY validation between a cashier's typing and an ETA filing — the sale path
 * carries no zod, and `buildInvoice`'s refusal happens inside the worker, hours
 * later, on a `failed` row nobody at the counter will ever see.
 */

const complete: BuyerDraft = {
  ...EMPTY_BUYER_DRAFT,
  rin: "123456789",
  name: "Nile Trading Co.",
  country: "EG",
  governate: "Cairo",
  regionCity: "Maadi",
  street: "Road 9",
  buildingNumber: "12",
};

describe("validateBuyerDraft", () => {
  it("passes a complete draft", () => {
    expect(validateBuyerDraft(complete)).toEqual({});
  });

  it("names EVERY missing mandatory field, not just the first", () => {
    // Seven inputs and one sentence would send a cashier hunting. The form marks
    // the boxes, so the validator has to know all of them at once.
    const errors = validateBuyerDraft(EMPTY_BUYER_DRAFT);
    // `country` is pre-filled with "EG" in the empty draft — every other
    // mandatory field is blank.
    for (const field of REQUIRED_BUYER_FIELDS) {
      if (field.key === "country") continue;
      expect(errors[field.key], `${field.key} was not reported`).toBeDefined();
    }
    expect(errors.country).toBeUndefined();
  });

  it("rejects a registration number that is not exactly nine digits", () => {
    // The field where a plausible wrong value is easiest to type and hardest to
    // recover from: the document is filed under it and cannot be edited in
    // place. Mirrors the server's `rinSchema` (`/^\d{9}$/`).
    for (const rin of ["12345678", "1234567890", "12345678a", "123 456 789", "١٢٣٤٥٦٧٨٩", ""]) {
      expect(validateBuyerDraft({ ...complete, rin }).rin, `"${rin}" was accepted`).toBeDefined();
    }
    expect(validateBuyerDraft({ ...complete, rin: "000000000" }).rin).toBeUndefined();
  });

  it("distinguishes an empty registration number from a malformed one", () => {
    expect(validateBuyerDraft({ ...complete, rin: "" }).rin).toBe("Required");
    expect(validateBuyerDraft({ ...complete, rin: "12345" }).rin).toBe("Must be exactly 9 digits");
  });

  it("treats whitespace as empty, and trims before matching the number", () => {
    expect(validateBuyerDraft({ ...complete, name: "   " }).name).toBe("Required");
    expect(validateBuyerDraft({ ...complete, rin: "  123456789  " }).rin).toBeUndefined();
  });

  it("never requires an optional address component", () => {
    const errors = validateBuyerDraft(complete);
    for (const field of OPTIONAL_BUYER_FIELDS) {
      expect(errors[field.key], `${field.key} was demanded`).toBeUndefined();
    }
  });

  it("routes the rin rule through the exported regex, not a second copy of it", () => {
    // WHAT THIS DOES AND DOES NOT PROVE, stated because the obvious reading is
    // wrong. It proves `validateBuyerDraft` and `BUYER_RIN_RE` agree — one rule,
    // not two. It does NOT prove either matches the server's `rinSchema`: this
    // package cannot import from the Next.js server tree at all, so an assertion
    // here can only ever check the regex against itself and would stay green
    // through any change to the server's rule.
    //
    // THE REAL CROSS-BOUNDARY GUARD LIVES SERVER-SIDE, beside `rinSchema`, and
    // reads this file as text: `config-service.test.ts`'s "the buyer RIN regex
    // does not drift across the server/till boundary".
    expect(BUYER_RIN_RE.test("123456789")).toBe(true);
    expect(BUYER_RIN_RE.test("12345678")).toBe(false);
    for (const rin of ["123456789", "12345678", "1234567890", "abcdefghi"]) {
      expect(validateBuyerDraft({ ...complete, rin }).rin === undefined).toBe(BUYER_RIN_RE.test(rin));
    }
  });
});

describe("buildPosSaleBuyer", () => {
  it("shapes the address as ETA's receiver block", () => {
    expect(buildPosSaleBuyer(complete)).toEqual({
      rin: "123456789",
      name: "Nile Trading Co.",
      address: {
        country: "EG",
        governate: "Cairo",
        regionCity: "Maadi",
        street: "Road 9",
        buildingNumber: "12",
      },
    });
  });

  it("OMITS a blank optional component rather than sending an empty string", () => {
    const built = buildPosSaleBuyer({ ...complete, postalCode: "  ", floor: "3" });
    expect(built!.address).not.toHaveProperty("postalCode");
    expect(built!.address.floor).toBe("3");
    // And the five mandatory ones are always there.
    expect(Object.keys(built!.address).sort())
      .toEqual(["buildingNumber", "country", "floor", "governate", "regionCity", "street"]);
  });

  it("trims every value it carries", () => {
    const built = buildPosSaleBuyer({ ...complete, rin: " 123456789 ", name: " Nile Trading Co. ", street: " Road 9 " });
    expect(built!.rin).toBe("123456789");
    expect(built!.name).toBe("Nile Trading Co.");
    expect(built!.address.street).toBe("Road 9");
  });

  it("REFUSES rather than coercing an incomplete draft", () => {
    // There is no partial tax invoice. Building one with a blank governate would
    // file a document ETA refuses — the exact failure this module moves forward
    // in time to the counter.
    expect(buildPosSaleBuyer({ ...complete, governate: "" })).toBeNull();
    expect(buildPosSaleBuyer({ ...complete, rin: "12345678" })).toBeNull();
    expect(buildPosSaleBuyer(EMPTY_BUYER_DRAFT)).toBeNull();
  });
});
