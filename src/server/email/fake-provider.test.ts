import { describe, it, expect } from "vitest";
import { FakeEmailProvider } from "./fake-provider";

const msg = (to: string, key: string) => ({
  from: "no-reply@mail.serveos.com", to, subject: "PO-1",
  html: "<p>PO</p>", idempotencyKey: key,
});

describe("FakeEmailProvider", () => {
  it("records sends and returns distinct provider ids", async () => {
    const p = new FakeEmailProvider();
    const a = await p.send(msg("a@x.com", "k1"));
    const b = await p.send(msg("b@x.com", "k2"));
    expect(a.providerMessageId).not.toEqual(b.providerMessageId);
    expect(p.sent.map((s) => s.to)).toEqual(["a@x.com", "b@x.com"]);
  });

  it("fails exactly once when told to — the retry-path fixture", async () => {
    const p = new FakeEmailProvider();
    p.failNext = new Error("provider down");
    await expect(p.send(msg("a@x.com", "k1"))).rejects.toThrow(/down/);
    await expect(p.send(msg("a@x.com", "k1"))).resolves.toBeTruthy();
  });

  it("returns the SAME id for a repeated idempotency key — provider-side dedupe", async () => {
    const p = new FakeEmailProvider();
    const a = await p.send(msg("a@x.com", "same-key"));
    const b = await p.send(msg("a@x.com", "same-key"));
    expect(b.providerMessageId).toBe(a.providerMessageId);
    expect(p.sent).toHaveLength(1); // the duplicate never "left the building"
  });
});
