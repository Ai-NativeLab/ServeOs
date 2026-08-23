import { describe, it, expect } from "vitest";
import { clientIp, parseEnquiry, FIELD_LIMITS } from "./enquiry-input";

const PLANS = ["basic", "pro", "enterprise"];
const valid = {
  plan: "pro",
  name: "Mona Adel",
  businessName: "El Nour Pharmacy",
  phone: "+20 100 123 4567",
  email: "mona@elnour.example",
  locale: "ar",
};

describe("parseEnquiry", () => {
  it("accepts a complete enquiry", () => {
    expect(parseEnquiry(valid, PLANS)).toEqual({
      kind: "ok",
      fields: {
        planKey: "pro",
        name: "Mona Adel",
        businessName: "El Nour Pharmacy",
        phone: "+20 100 123 4567",
        email: "mona@elnour.example",
        locale: "ar",
      },
    });
  });

  // The honeypot answers "ok" so a bot learns nothing, but nothing is written.
  it("ignores a submission that filled the honeypot", () => {
    expect(parseEnquiry({ ...valid, company: "Acme Inc" }, PLANS)).toEqual({ kind: "ignore" });
  });

  it("does not treat a whitespace-only honeypot as filled", () => {
    expect(parseEnquiry({ ...valid, company: "   " }, PLANS).kind).toBe("ok");
  });

  it("rejects a plan key that is not a real plan", () => {
    expect(parseEnquiry({ ...valid, plan: "platinum" }, PLANS)).toEqual({ kind: "invalid" });
  });

  it("rejects a missing plan key", () => {
    expect(parseEnquiry({ ...valid, plan: undefined }, PLANS)).toEqual({ kind: "invalid" });
  });

  it.each(["name", "businessName", "phone", "email"] as const)("requires %s", (field) => {
    expect(parseEnquiry({ ...valid, [field]: "   " }, PLANS)).toEqual({ kind: "invalid" });
  });

  it("trims surrounding whitespace", () => {
    const parsed = parseEnquiry({ ...valid, name: "  Mona Adel  " }, PLANS);
    expect(parsed.kind === "ok" && parsed.fields.name).toBe("Mona Adel");
  });

  // Unbounded, one request could write megabytes into the table and the email.
  it.each([
    ["name", FIELD_LIMITS.name],
    ["businessName", FIELD_LIMITS.businessName],
    ["phone", FIELD_LIMITS.phone],
  ] as const)("rejects %s beyond its limit", (field, limit) => {
    expect(parseEnquiry({ ...valid, [field]: "x".repeat(limit + 1) }, PLANS)).toEqual({ kind: "invalid" });
    expect(parseEnquiry({ ...valid, [field]: "x".repeat(limit) }, PLANS).kind).toBe("ok");
  });

  it("rejects an address beyond the RFC maximum", () => {
    const long = `${"x".repeat(FIELD_LIMITS.email)}@e.com`;
    expect(parseEnquiry({ ...valid, email: long }, PLANS)).toEqual({ kind: "invalid" });
  });

  // A malformed address makes the provider reject the whole send, leaving the
  // lead unsent while the visitor is told it went through.
  it.each(["mona", "mona@", "@elnour.example", "mona elnour@x.com", "mona@elnour"])(
    "rejects the malformed address %s",
    (email) => {
      expect(parseEnquiry({ ...valid, email }, PLANS)).toEqual({ kind: "invalid" });
    },
  );

  it("defaults to Arabic and only accepts en as the alternative", () => {
    const ar = parseEnquiry({ ...valid, locale: undefined }, PLANS);
    expect(ar.kind === "ok" && ar.fields.locale).toBe("ar");
    const bogus = parseEnquiry({ ...valid, locale: "fr" }, PLANS);
    expect(bogus.kind === "ok" && bogus.fields.locale).toBe("ar");
    const en = parseEnquiry({ ...valid, locale: "en" }, PLANS);
    expect(en.kind === "ok" && en.fields.locale).toBe("en");
  });
});

describe("clientIp", () => {
  it("takes the first entry of the forwarded chain", () => {
    expect(clientIp("41.33.1.9, 10.0.0.1, 10.0.0.2", null)).toBe("41.33.1.9");
  });

  it("falls back to x-real-ip", () => {
    expect(clientIp(null, "41.33.1.9")).toBe("41.33.1.9");
  });

  it("is null when nothing identifies the caller, so nothing is capped", () => {
    expect(clientIp(null, null)).toBeNull();
    expect(clientIp("", "  ")).toBeNull();
  });
});
