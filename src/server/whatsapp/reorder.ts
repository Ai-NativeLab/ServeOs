import { and, desc, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orders, orderItems } from "@/server/ordering/schema";
import { products } from "@/server/catalog/schema";
import type { CartLine } from "./schema";

/** A conversation idle longer than this restarts instead of resuming. */
export const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Meta sends wa_id bare ("201..."); orders.customerPhone carries the plus. */
export function toE164(waId: string): string {
  return waId.startsWith("+") ? waId : `+${waId}`;
}

/**
 * The lines of this number's most recent order PLACED THROUGH WHATSAPP.
 *
 * Scoped to channel = 'whatsapp' on purpose. orders.customerPhone is unvalidated
 * free text from web checkout and POS walk-ins, so a broader match would show a
 * recycled number's new owner the previous owner's history.
 *
 * Unpublished products are dropped rather than returned, so a reorder degrades
 * to "some items are gone" instead of failing the whole order at placeOrder.
 */
export async function lastWhatsappCart(tenantId: string, waId: string): Promise<CartLine[] | null> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx.select({ id: orders.id }).from(orders)
      .where(and(
        eq(orders.tenantId, tenantId),
        eq(orders.channel, "whatsapp"),
        eq(orders.customerPhone, toE164(waId)),
      ))
      .orderBy(desc(orders.placedAt))
      .limit(1);
    if (!order) return null;

    const items = await tx.select({
      productId: orderItems.productId,
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
    }).from(orderItems).where(eq(orderItems.orderId, order.id));
    if (items.length === 0) return [];

    const live = await tx.select({ id: products.id }).from(products)
      .where(and(
        inArray(products.id, items.map((i) => i.productId)),
        eq(products.isPublished, true),
      ));
    const liveIds = new Set(live.map((p) => p.id));

    return items
      .filter((i) => liveIds.has(i.productId))
      .map((i) => ({
        productId: i.productId,
        ...(i.variantId ? { variantId: i.variantId } : {}),
        quantity: i.quantity,
      }));
  });
}
