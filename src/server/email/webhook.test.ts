import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySvixSignature, parseResendWebhook, WebhookSignatureError } from "./webhook";

const RAW_SECRET = Buffer.from("super-secret-signing-key");
const SECRET = "whsec_" + RAW_SECRET.toString("base64");

function sign(id: string, timestamp: string, body: string): string {
  const mac = createHmac("sha256", RAW_SECRET).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${mac}`;
}

function headersFor(body: string, over: Partial<Record<string, string>> = {}) {
  const id = over["svix-id"] ?? "msg_1";
  const ts = over["svix-timestamp"] ?? String(Math.floor(Date.now() / 1000));
  return {
    "svix-id": id,
    "svix-timestamp": ts,
    "svix-signature": over["svix-signature"] ?? sign(id, ts, body),
  };
}

describe("verifySvixSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = '{"type":"email.delivered"}';
    expect(verifySvixSignature(body, headersFor(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"type":"email.delivered"}';
    const h = headersFor(body);
    expect(verifySvixSignature(body + " ", h, SECRET)).toBe(false);
  });

  it("fails closed on missing or malformed headers, never throws", () => {
    const body = "{}";
    expect(verifySvixSignature(body, {}, SECRET)).toBe(false);
    expect(verifySvixSignature(body, { "svix-id": "a", "svix-timestamp": "b", "svix-signature": "garbage" }, SECRET)).toBe(false);
    expect(verifySvixSignature(body, headersFor(body), "not-a-whsec-secret")).toBe(false);
  });

  it("rejects a stale timestamp — replayed webhooks don't verify", () => {
    const body = "{}";
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const h = { "svix-id": "msg_1", "svix-timestamp": staleTs, "svix-signature": sign("msg_1", staleTs, body) };
    expect(verifySvixSignature(body, h, SECRET)).toBe(false);
  });

  it("accepts when any signature in a space-separated list matches", () => {
    const body = "{}";
    const ts = String(Math.floor(Date.now() / 1000));
    const good = sign("msg_1", ts, body);
    const h = { "svix-id": "msg_1", "svix-timestamp": ts, "svix-signature": `v1,AAAA ${good}` };
    expect(verifySvixSignature(body, h, SECRET)).toBe(true);
  });
});

describe("parseResendWebhook", () => {
  const event = (type: string) => JSON.stringify({ type, created_at: "2026-08-03", data: { email_id: "re_123" } });

  it("normalizes delivery events and keys dedupe on the svix message id", () => {
    const body = event("email.delivered");
    const parsed = parseResendWebhook(body, headersFor(body, { "svix-id": "msg_evt_9" }), SECRET);
    expect(parsed).toEqual({
      provider: "resend",
      providerMessageId: "re_123",
      providerEventId: "msg_evt_9",
      eventType: "delivered",
      raw: JSON.parse(body),
    });
  });

  it.each([
    ["email.bounced", "bounced"],
    ["email.complained", "complained"],
    ["email.opened", "opened"],
  ])("maps %s to %s", (type, expected) => {
    const body = event(type);
    expect(parseResendWebhook(body, headersFor(body), SECRET)?.eventType).toBe(expected);
  });

  it("returns null for event types we don't track rather than failing", () => {
    const body = event("email.clicked");
    expect(parseResendWebhook(body, headersFor(body), SECRET)).toBeNull();
  });

  it("throws WebhookSignatureError on a bad signature", () => {
    const body = event("email.delivered");
    expect(() => parseResendWebhook(body, { "svix-id": "x", "svix-timestamp": "1", "svix-signature": "v1,bad" }, SECRET))
      .toThrow(WebhookSignatureError);
  });
});
