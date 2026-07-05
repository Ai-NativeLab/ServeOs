import { describe, it, expect } from "vitest";
import { InvalidWhatsappNumberError } from "./errors";

describe("tenancy errors", () => {
  it("InvalidWhatsappNumberError carries a code and localized messages", () => {
    const err = new InvalidWhatsappNumberError("not-a-number");
    expect(err.code).toBe("invalid_whatsapp_number");
    expect(err.messageFor("en")).toContain("Invalid WhatsApp number");
    expect(err.messageFor("ar")).toContain("واتساب");
  });
});
