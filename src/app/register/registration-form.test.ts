import { describe, it, expect } from "vitest";
import { parseRegistration } from "./registration-form";

function form(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const fields: Record<string, string> = {
    vertical: "restaurant",
    restaurantName: "Roma Ristorante",
    slug: "roma",
    country: "EG",
    ownerName: "Ahmed Hassan",
    email: "ahmed@roma.com",
    password: "correcthorse",
    ...overrides,
  };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("parseRegistration", () => {
  it("lowercases and trims the subdomain a phone keyboard capitalised", () => {
    const result = parseRegistration(form({ slug: "  Roma " }));
    expect(result.ok && result.input.slug).toBe("roma");
  });

  it.each(["ab", "roma ristorante", "-roma", "roma_1"])(
    "returns a subdomain field error for %j instead of throwing, keeping what was typed",
    (slug) => {
      const result = parseRegistration(form({ slug }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.state.errors.slug).toMatch(/3.32|letters|numbers|hyphen/i);
      expect(result.state.values.restaurantName).toBe("Roma Ristorante");
      expect(result.state.values.email).toBe("ahmed@roma.com");
    },
  );

  it("stores the email trimmed and lowercased, so login can find it whatever the casing", () => {
    const result = parseRegistration(form({ email: " Ahmed@Roma.COM " }));
    expect(result.ok && result.input.email).toBe("ahmed@roma.com");
  });

  it("rejects a password under 8 characters and never echoes it back", () => {
    const result = parseRegistration(form({ password: "short1" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state.errors.password).toMatch(/8 characters/);
    expect(JSON.stringify(result.state)).not.toContain("short1");
  });
});
