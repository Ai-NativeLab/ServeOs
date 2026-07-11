import { sql, desc } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { orderItems } from "@/server/ordering/schema";

const POPULAR_LIMIT = 5;

/** Top product ids by lifetime ordered quantity (only products with ≥1 order). */
export async function getPopularProductIds(tenantId: string): Promise<Set<string>> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ productId: orderItems.productId, qty: sql<number>`sum(${orderItems.quantity})::int` })
      .from(orderItems)
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`sum(${orderItems.quantity})`))
      .limit(POPULAR_LIMIT);
    return new Set(rows.map((r) => r.productId));
  });
}
