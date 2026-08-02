import { describe, it, expect } from "vitest";
import { parseWebhook } from "./payload";

const msg = (pnId: string, wamid: string, body: string) => ({
  id: "entry-" + wamid,
  changes: [{
    field: "messages",
    value: {
      metadata: { phone_number_id: pnId, display_phone_number: "+201000000000" },
      contacts: [{ profile: { name: "Ahmed" }, wa_id: "201111111111" }],
      messages: [{ from: "201111111111", id: wamid, timestamp: "1750000000", type: "text", text: { body } }],
    },
  }],
});

describe("parseWebhook", () => {
  it("returns every message in a batch spanning multiple tenants", () => {
    const { messages } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [msg("pn-A", "wamid.1", "hi"), msg("pn-B", "wamid.2", "hello")],
    });
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.phoneNumberId)).toEqual(["pn-A", "pn-B"]);
    expect(messages[0].event).toEqual({ kind: "text", text: "hi" });
    expect(messages[0].profileName).toBe("Ahmed");
  });

  it("returns multiple messages batched inside one change", () => {
    const e = msg("pn-A", "wamid.1", "one");
    e.changes[0].value.messages.push({
      from: "201111111111", id: "wamid.2", timestamp: "1750000001", type: "text", text: { body: "two" },
    } as never);
    const { messages } = parseWebhook({ object: "whatsapp_business_account", entry: [e] });
    expect(messages).toHaveLength(2);
  });

  it("separates status callbacks from inbound messages", () => {
    const { messages, statuses } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "e1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn-A" },
            statuses: [{ id: "wamid.out.1", status: "delivered", timestamp: "1750000000" }],
          },
        }],
      }],
    });
    expect(messages).toHaveLength(0);
    expect(statuses).toEqual([{ providerMessageId: "wamid.out.1", status: "delivered" }]);
  });

  it("maps an interactive reply to its stable id, not its localized title", () => {
    const { messages } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "e1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn-A" },
            contacts: [{ profile: { name: "Ahmed" }, wa_id: "201111111111" }],
            messages: [{
              from: "201111111111", id: "wamid.3", timestamp: "1750000000", type: "interactive",
              interactive: { type: "list_reply", list_reply: { id: "add:7:prod-1", title: "Margherita" } },
            }],
          },
        }],
      }],
    });
    expect(messages[0].event).toEqual({ kind: "interactive", replyId: "add:7:prod-1" });
  });

  it("classifies media and stickers as unsupported rather than dropping them", () => {
    const { messages } = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "e1",
        changes: [{
          field: "messages",
          value: {
            metadata: { phone_number_id: "pn-A" },
            contacts: [{ profile: { name: "A" }, wa_id: "201111111111" }],
            messages: [{ from: "201111111111", id: "wamid.4", timestamp: "1750000000", type: "sticker", sticker: { id: "s1" } }],
          },
        }],
      }],
    });
    expect(messages[0].event).toEqual({ kind: "unsupported" });
  });

  it("returns empty for junk rather than throwing", () => {
    expect(parseWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook({ entry: "nope" })).toEqual({ messages: [], statuses: [] });
  });
});
