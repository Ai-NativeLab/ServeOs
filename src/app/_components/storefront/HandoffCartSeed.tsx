"use client";
import { useEffect } from "react";
import { saveCart, type CartLine } from "@/app/_components/cart";

/**
 * Seeds the storefront cart from a redeemed WhatsApp handoff token.
 *
 * The cart lives in localStorage behind loadCart()/saveCart() and every
 * template re-reads it on the `serveos-cart-changed` event, so writing the
 * store once on mount reaches ShopBrowser AND the restaurant menu alike —
 * threading initial state through props would be overwritten by the mount-time
 * loadCart() hydration. Replacing (not merging) is deliberate: the customer
 * explicitly tapped "finish your order here" with THIS basket.
 */
export function HandoffCartSeed({ branchId, lines }: { branchId: string | null; lines: CartLine[] }) {
  useEffect(() => {
    if (lines.length > 0) saveCart({ branchId, lines });
    // Seed exactly once for this render of the redeemed token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
