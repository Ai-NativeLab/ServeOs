"use server";

import { revalidatePath } from "next/cache";
import { requirePurchasingPermission, resolvePurchasingActor } from "../../purchasing-permission";
import {
  upsertReorderRule,
  checkReorder,
  type ReorderRuleInput,
} from "@/server/purchasing/reorder";

export async function upsertReorderRuleAction(
  data: ReorderRuleInput,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    if (!data.itemId) return { error: "Item is required" };
    if (!data.locationId) return { error: "Location is required" };
    if (typeof data.reorderPoint !== "number" || isNaN(data.reorderPoint) || data.reorderPoint < 0) {
      return { error: "Reorder point must be a non-negative number" };
    }
    if (typeof data.reorderQty !== "number" || isNaN(data.reorderQty) || data.reorderQty <= 0) {
      return { error: "Reorder quantity must be greater than 0" };
    }

    const actor = await resolvePurchasingActor(ctx);
    await upsertReorderRule(actor, {
      itemId: data.itemId,
      locationId: data.locationId,
      reorderPoint: data.reorderPoint,
      reorderQty: data.reorderQty,
      preferredSupplierId: data.preferredSupplierId || undefined,
    });

    revalidatePath("/dashboard/purchase-orders/reorder-rules");
    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to save reorder rule" };
  }
}

export async function runReorderCheckAction(): Promise<
  { error: string } | { success: true; triggered: number; draftsCreated: number }
> {
  try {
    const ctx = await requirePurchasingPermission("purchasing:manage");
    const actor = await resolvePurchasingActor(ctx);
    const result = await checkReorder(actor);

    revalidatePath("/dashboard/purchase-orders/reorder-rules");
    revalidatePath("/dashboard/purchase-orders");
    return { success: true, triggered: result.triggered, draftsCreated: result.draftsCreated };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed to run reorder check" };
  }
}
