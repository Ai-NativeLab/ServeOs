import type { EmailEventType } from "@/server/notifications/schema";

export type EmailMessage = {
  from: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  /** The outbox row id. The provider deduplicates a retried identical request
   *  on this key, closing the crash-after-accept double-send window. */
  idempotencyKey: string;
};

/** Shaped like BillingProvider (src/server/billing/provider.ts): a tiny
 *  interface, one concrete implementation behind it, env-selected once. */
export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export type ParsedEmailEvent = {
  provider: string;
  providerMessageId: string;
  providerEventId: string;
  eventType: EmailEventType;
  raw: Record<string, unknown>;
};
