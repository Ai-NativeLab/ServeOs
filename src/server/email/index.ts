import type { EmailProvider } from "./provider";
import { ResendEmailProvider } from "./resend-provider";
import { FakeEmailProvider } from "./fake-provider";

export type { EmailProvider, EmailMessage, ParsedEmailEvent } from "./provider";
export { ResendEmailProvider } from "./resend-provider";
export { FakeEmailProvider } from "./fake-provider";
export { verifySvixSignature, parseResendWebhook, WebhookSignatureError } from "./webhook";
export { defaultSender } from "./sender";

/** Resolved once from EMAIL_PROVIDER. Swapping Resend → Brevo → SES is an env
 *  change plus DNS re-verification — no call site knows which one is active. */
export function activeEmailProvider(): EmailProvider {
  switch (process.env.EMAIL_PROVIDER ?? "resend") {
    case "fake":
      return new FakeEmailProvider();
    case "resend":
    default:
      return new ResendEmailProvider();
  }
}
