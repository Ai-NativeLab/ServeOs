import type { EmailMessage, EmailProvider } from "./provider";

export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  public sent: EmailMessage[] = [];
  /** Set to make the NEXT send reject once — the retry-path fixture. */
  public failNext: Error | null = null;
  private byKey = new Map<string, string>();
  private n = 0;

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    // Provider-side idempotency: a repeated key returns the original id and
    // does not send again — mirroring what the real provider's dedupe does.
    const existing = this.byKey.get(message.idempotencyKey);
    if (existing) return { providerMessageId: existing };

    const id = `fake_${this.n++}`;
    this.byKey.set(message.idempotencyKey, id);
    this.sent.push(message);
    return { providerMessageId: id };
  }
}
