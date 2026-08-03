import type { EmailMessage, EmailProvider } from "./provider";

const RESEND_API = "https://api.resend.com/emails";

/**
 * The first concrete EmailProvider (roadmap D7). One HTTP call per send;
 * Resend deduplicates on the Idempotency-Key header, which carries the outbox
 * row id — a retried identical request cannot become a second email.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");

    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
      }),
    });
    if (!res.ok) {
      // Never include the API key or the raw response body in the thrown message.
      throw new Error(`Resend send failed: ${res.status}`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error("Resend returned no message id");
    return { providerMessageId: json.id };
  }
}
