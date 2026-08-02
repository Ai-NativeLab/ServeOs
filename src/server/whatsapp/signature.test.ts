import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "./signature";

const SECRET = "test-app-secret";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"object":"whatsapp_business_account"}';
    expect(verifyWebhookSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("fails closed on a missing header", () => {
    expect(verifyWebhookSignature("{}", null, SECRET)).toBe(false);
  });

  it("fails closed on a malformed header rather than throwing", () => {
    // timingSafeEqual throws on unequal buffer lengths — that must not escape.
    expect(verifyWebhookSignature("{}", "sha256=abcd", SECRET)).toBe(false);
    expect(verifyWebhookSignature("{}", "garbage", SECRET)).toBe(false);
    expect(verifyWebhookSignature("{}", "sha256=", SECRET)).toBe(false);
    expect(verifyWebhookSignature("{}", "sha256=zzzz-not-hex", SECRET)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const body = "{}";
    const wrong = "sha256=" + createHmac("sha256", "other").update(body).digest("hex");
    expect(verifyWebhookSignature(body, wrong, SECRET)).toBe(false);
  });
});
