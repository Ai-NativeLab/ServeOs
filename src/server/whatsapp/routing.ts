import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { whatsappAccounts, whatsappMessages, type WhatsappAccount } from "./schema";
import type { InboundMessage } from "./payload";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Control-plane lookup: runs OUTSIDE withTenant because the tenant is exactly
 * what we are trying to discover. Only `active` rows route — a disconnected or
 * suspended account must stop receiving orders immediately.
 */
export async function resolveAccount(phoneNumberId: string): Promise<WhatsappAccount | null> {
  const [row] = await db.select().from(whatsappAccounts)
    .where(and(eq(whatsappAccounts.phoneNumberId, phoneNumberId), eq(whatsappAccounts.status, "active")))
    .limit(1);
  return row ?? null;
}

/**
 * Records an inbound message. Returns false when this providerMessageId has
 * already been stored, which is the signal to skip processing entirely — Meta
 * retries a failed delivery for up to 7 days.
 */
export async function recordInbound(account: WhatsappAccount, msg: InboundMessage, tx: Tx): Promise<boolean> {
  const inserted = await tx.insert(whatsappMessages).values({
    tenantId: account.tenantId,
    waId: msg.waId,
    direction: "inbound",
    providerMessageId: msg.providerMessageId,
    payload: { event: msg.event, timestamp: msg.timestamp, profileName: msg.profileName },
  }).onConflictDoNothing({ target: whatsappMessages.providerMessageId }).returning({ id: whatsappMessages.id });
  return inserted.length > 0;
}

/** The tenant's ACTIVE account — the sender identity for outbound status
 *  messages. Control-plane read, like resolveAccount. */
export async function resolveAccountForTenant(tenantId: string): Promise<WhatsappAccount | null> {
  const [row] = await db.select().from(whatsappAccounts)
    .where(and(eq(whatsappAccounts.tenantId, tenantId), eq(whatsappAccounts.status, "active")))
    .limit(1);
  return row ?? null;
}
