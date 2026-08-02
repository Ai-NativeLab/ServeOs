import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { cartHandoffTokens, type CartHandoffToken, type CartLine } from "./schema";

const DEFAULT_TTL_MINUTES = 60;

export async function mintHandoff(
  tenantId: string, waId: string, branchId: string | null, cart: CartLine[],
  ttlMinutes = DEFAULT_TTL_MINUTES,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withTenant(tenantId, (tx) => tx.insert(cartHandoffTokens).values({
    tenantId, token, waId, branchId, cart,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  }));
  return token;
}

/**
 * Single-use redemption. `tenantId` MUST come from the storefront host the
 * customer opened, never from the token — RLS then makes a cross-tenant replay
 * return nothing rather than render another tenant's cart.
 */
export async function redeemHandoff(tenantId: string, token: string): Promise<CartHandoffToken | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx.update(cartHandoffTokens)
      .set({ redeemedAt: new Date() })
      .where(and(
        eq(cartHandoffTokens.token, token),
        eq(cartHandoffTokens.tenantId, tenantId),
        isNull(cartHandoffTokens.redeemedAt),
        gt(cartHandoffTokens.expiresAt, new Date()),
      ))
      .returning();
    return row ?? null;
  });
}
