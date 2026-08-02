import { describe, it, expect } from "vitest";
import { FakeWhatsAppProvider } from "./fake-provider";
import type { WhatsappAccount } from "./schema";

const account = { id: "a", phoneNumberId: "pn-1", tokenRef: "sm://x" } as WhatsappAccount;

describe("FakeWhatsAppProvider", () => {
  it("records what was sent and returns a unique message id", async () => {
    const p = new FakeWhatsAppProvider();
    const id1 = await p.send(account, "201111111111", { kind: "text", body: "hi" });
    const id2 = await p.send(account, "201111111111", { kind: "text", body: "again" });
    expect(id1).not.toEqual(id2);
    expect(p.sent).toHaveLength(2);
    expect(p.sent[0]).toMatchObject({ waId: "201111111111", msg: { kind: "text", body: "hi" } });
  });

  it("rejects a list with more than 10 rows — Meta's hard cap across ALL sections", async () => {
    const p = new FakeWhatsAppProvider();
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
    await expect(p.send(account, "2011", { kind: "list", body: "b", button: "Pick", rows }))
      .rejects.toThrow(/10 rows/);
  });

  it("rejects a row title over 24 characters", async () => {
    const p = new FakeWhatsAppProvider();
    await expect(p.send(account, "2011", {
      kind: "list", body: "b", button: "Pick",
      rows: [{ id: "r", title: "This title is definitely too long" }],
    })).rejects.toThrow(/24/);
  });

  it("rejects more than 3 buttons", async () => {
    const p = new FakeWhatsAppProvider();
    const buttons = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` }));
    await expect(p.send(account, "2011", { kind: "buttons", body: "b", buttons })).rejects.toThrow(/3 buttons/);
  });
});
