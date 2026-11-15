import { describe, it, expect } from "vitest";
import { SLUG_PATTERN, isValidSlug } from "./slug";

describe("SLUG_PATTERN", () => {
  // Browsers compile an <input pattern> with the `v` flag, where an unescaped
  // `-` inside a character class is a syntax error. Chrome then logs "not a
  // valid regular expression" and silently skips the check on every phone.
  it("compiles the way browsers compile the pattern attribute", () => {
    expect(() => new RegExp(`^(?:${SLUG_PATTERN})$`, "v")).not.toThrow();
  });

  it("accepts and rejects the same subdomains as isValidSlug", () => {
    const browser = new RegExp(`^(?:${SLUG_PATTERN})$`, "v");
    for (const slug of ["roma", "pizza-roma", "r2d", "ab", "-roma", "roma-", "Roma", "roma_1", "a".repeat(33)]) {
      expect(browser.test(slug), slug).toBe(isValidSlug(slug));
    }
  });
});
