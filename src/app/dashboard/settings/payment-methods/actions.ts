"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { upsertOfflineMethod, deleteOfflineMethod } from "@/server/payments/offline/methods";
import type { OfflineMethodType } from "@/server/payments/offline";

/**
 * Order-valid subset only. `cash` is the always-available COD default and isn't
 * configured here; `bank` is in OFFLINE_METHOD_TYPES but is NOT a valid order
 * paymentMethod (the order enum is cash/instapay/vodafone_cash/mobile_wallet — see
 * paymentMethodEnum in @/server/ordering/schema). Offering either in this dropdown
 * would let an owner create a method that silently falls back to cash at checkout.
 */
export const ORDER_METHOD_TYPES = ["instapay", "vodafone_cash", "mobile_wallet"] as const;

export async function saveOfflineMethodAction(formData: FormData) {
  const { tenantId, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "fulfillment:manage");

  const type = String(formData.get("type"));
  if (!(ORDER_METHOD_TYPES as readonly string[]).includes(type)) {
    throw new Error("Unsupported payment method type");
  }
  const label = String(formData.get("label") || "").trim();
  if (!label) throw new Error("Label is required");

  const id = formData.get("id") ? String(formData.get("id")) : undefined;

  // No app-level dedupe needed: `tenant_offline_methods` has a DB-level unique
  // index on (tenant_id, type), and upsertOfflineMethod's insert path uses
  // onConflictDoUpdate, so creating a method of an existing type atomically
  // updates it in place instead of racing or throwing.
  await upsertOfflineMethod(tenantId, {
    id,
    type: type as OfflineMethodType,
    label,
    payToDetail: formData.get("payToDetail") ? String(formData.get("payToDetail")) : null,
    enabled: formData.get("enabled") === "true",
  });
  revalidatePath("/dashboard/settings/payment-methods");
}

export async function deleteOfflineMethodAction(id: string) {
  const { tenantId, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "fulfillment:manage");
  await deleteOfflineMethod(tenantId, id);
  revalidatePath("/dashboard/settings/payment-methods");
}
