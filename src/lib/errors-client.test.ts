import { describe, it, expect } from "vitest";
import { toastMessageFor } from "./errors-client";
import { InvalidWhatsappNumberError } from "@/server/tenancy/errors";

describe("toastMessageFor", () => {
  it("surfaces a DomainError's English message", () => {
    expect(toastMessageFor(new InvalidWhatsappNumberError("bad"))).toBe(
      "Invalid WhatsApp number — use international format, e.g. +201234567890",
    );
  });

  it("falls back to a generic message for non-domain errors", () => {
    expect(toastMessageFor(new Error("boom"))).toBe("Something went wrong. Please try again.");
    expect(toastMessageFor("boom")).toBe("Something went wrong. Please try again.");
  });
});
