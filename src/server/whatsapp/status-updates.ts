import type { db } from "@/db/client";
import { whatsappStatusQueue } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The transitions worth announcing, and nothing else — preparing is kitchen
 *  detail, cancelled/rejected get no cheery proactive ping in v1. */
const STATUS_COPY: Record<string, (orderNumber: number) => string> = {
  confirmed: (n) => `Order #${n} is confirmed — we're on it! 👨‍🍳`,
  ready: (n) => `Order #${n} is ready for pickup. See you soon!`,
  out_for_delivery: (n) => `Order #${n} is on its way to you. 🛵`,
};

/**
 * Enqueues a proactive status message for a WhatsApp order, ON THE CALLER'S
 * TX — the row commits atomically with the status change it announces.
 * Never sends: the scheduled worker owns delivery, the 24h-window check and
 * the retry policy. A non-whatsapp order or a silent status is a no-op.
 */
export async function enqueueStatusUpdate(
  tx: Tx,
  order: { id: string; tenantId: string; channel: string; customerPhone: string; orderNumber: number },
  toStatus: string,
): Promise<void> {
  if (order.channel !== "whatsapp") return;
  const copy = STATUS_COPY[toStatus];
  if (!copy) return;

  await tx.insert(whatsappStatusQueue).values({
    tenantId: order.tenantId,
    orderId: order.id,
    // orders.customerPhone carries E.164 (+2011…); wa_id is the bare digits.
    waId: order.customerPhone.replace(/^\+/, ""),
    body: copy(order.orderNumber),
  });
}
