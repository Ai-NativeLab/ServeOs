"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { upsertOfflineMethod, deleteOfflineMethod } from "@/server/payments/offline/methods";
import type { OfflineMethodType } from "@/server/payments/offline";
import { domainErrorValue } from "../../action-errors";
import { ORDER_METHOD_TYPES } from "./method-types";

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

  try {
    await upsertOfflineMethod(tenantId, {
      id,
      type: type as OfflineMethodType,
      label,
      payToDetail: formData.get("payToDetail") ? String(formData.get("payToDetail")) : null,
      enabled: formData.get("enabled") === "true",
    });
    revalidatePath("/dashboard/settings/payment-methods");
  } catch (e) {
    return domainErrorValue(e);
  }
}

export async function deleteOfflineMethodAction(id: string) {
  const { tenantId, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "fulfillment:manage");
  try {
    await deleteOfflineMethod(tenantId, id);
    revalidatePath("/dashboard/settings/payment-methods");
  } catch (e) {
    return domainErrorValue(e);
  }
}
