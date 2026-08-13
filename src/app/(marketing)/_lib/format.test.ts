import { describe, it, expect } from "vitest";
import { formatEgp, ordinal } from "./format";

const ARABIC_INDIC = /[٠-٩]/;
const WESTERN = /[0-9]/;

describe("formatEgp", () => {
  it("renders Arabic-Indic digits in Arabic", () => {
    const out = formatEgp(1497, "ar");
    expect(out).toMatch(ARABIC_INDIC);
    expect(out).not.toMatch(WESTERN);
  });

  it("renders Western digits in English", () => {
    const out = formatEgp(1497, "en");
    expect(out).toMatch(WESTERN);
    expect(out).not.toMatch(ARABIC_INDIC);
  });

  it("shows no fractional pounds", () => {
    expect(formatEgp(1497, "en")).not.toContain(".");
  });

  it("formats zero without throwing", () => {
    expect(formatEgp(0, "ar")).toMatch(ARABIC_INDIC);
  });
});

describe("ordinal", () => {
  it("pads Arabic numerals with an Arabic-Indic zero", () => {
    expect(ordinal(0, "ar")).toBe("٠١");
    expect(ordinal(2, "ar")).toBe("٠٣");
  });

  it("pads English numerals with an ASCII zero", () => {
    expect(ordinal(0, "en")).toBe("01");
    expect(ordinal(2, "en")).toBe("03");
  });

  it("does not pad past two digits", () => {
    expect(ordinal(9, "en")).toBe("10");
  });
});
