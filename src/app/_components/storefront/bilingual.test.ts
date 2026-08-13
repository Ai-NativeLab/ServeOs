import { describe, it, expect } from "vitest";
import { arabicDescription } from "./bilingual";

describe("arabicDescription", () => {
  it("returns the Arabic line when it is a real translation", () => {
    expect(arabicDescription("Charcoal-grilled.", "مشوية على الفحم.")).toBe("مشوية على الفحم.");
  });

  // The regression this exists for: the demo seed wrote descriptionAr = descEn,
  // so every seeded product rendered the identical English sentence twice.
  it("returns null when the Arabic column is just a copy of the English", () => {
    const en = "Charcoal-grilled, lemon-garlic marinade.";
    expect(arabicDescription(en, en)).toBeNull();
  });

  it("ignores whitespace when comparing — a trailing space is not a translation", () => {
    expect(arabicDescription("Grilled.", "  Grilled. ")).toBeNull();
  });

  it("returns null for missing, empty or whitespace-only Arabic", () => {
    expect(arabicDescription("Grilled.", null)).toBeNull();
    expect(arabicDescription("Grilled.", undefined)).toBeNull();
    expect(arabicDescription("Grilled.", "")).toBeNull();
    expect(arabicDescription("Grilled.", "   ")).toBeNull();
  });

  it("still shows Arabic when there is no English to duplicate", () => {
    expect(arabicDescription(null, "مشوية على الفحم.")).toBe("مشوية على الفحم.");
    expect(arabicDescription("", "مشوية على الفحم.")).toBe("مشوية على الفحم.");
  });

  it("trims what it returns, so the markup never carries stray padding", () => {
    expect(arabicDescription("Grilled.", "  مشوية.  ")).toBe("مشوية.");
  });
});
