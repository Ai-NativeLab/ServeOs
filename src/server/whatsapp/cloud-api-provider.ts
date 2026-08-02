import { assertSendable, type OutboundMessage, type WhatsAppProvider } from "./provider";
import { resolveToken } from "./secrets";
import type { WhatsappAccount } from "./schema";

const GRAPH = "https://graph.facebook.com/v21.0";

function toBody(waId: string, msg: OutboundMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to: waId };
  if (msg.kind === "text") return { ...base, type: "text", text: { body: msg.body } };
  if (msg.kind === "buttons") {
    return {
      ...base, type: "interactive",
      interactive: {
        type: "button", body: { text: msg.body },
        action: { buttons: msg.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    };
  }
  return {
    ...base, type: "interactive",
    interactive: {
      type: "list", body: { text: msg.body },
      action: { button: msg.button, sections: [{ title: "Options", rows: msg.rows }] },
    },
  };
}

export class CloudApiProvider implements WhatsAppProvider {
  async send(account: WhatsappAccount, waId: string, msg: OutboundMessage): Promise<string> {
    assertSendable(msg);
    const token = await resolveToken(account.tokenRef);
    const res = await fetch(`${GRAPH}/${account.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(toBody(waId, msg)),
    });
    if (!res.ok) {
      // Never include the token or the raw response in the thrown message.
      throw new Error(`WhatsApp send failed: ${res.status}`);
    }
    const json = (await res.json()) as { messages?: { id: string }[] };
    const id = json.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp send returned no message id");
    return id;
  }
}
