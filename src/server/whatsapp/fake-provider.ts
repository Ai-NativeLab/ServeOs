import { assertSendable, type OutboundMessage, type WhatsAppProvider } from "./provider";
import type { WhatsappAccount } from "./schema";

export class FakeWhatsAppProvider implements WhatsAppProvider {
  public sent: { waId: string; msg: OutboundMessage }[] = [];
  private n = 0;

  async send(_account: WhatsappAccount, waId: string, msg: OutboundMessage): Promise<string> {
    assertSendable(msg);
    this.sent.push({ waId, msg });
    return `wamid.fake.${this.n++}`;
  }
}
