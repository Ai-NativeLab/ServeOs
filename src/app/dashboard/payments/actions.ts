"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { confirmOrderPayment, rejectOrderPayment } from "@/server/ordering/service";
import { domainErrorValue } from "../action-errors";

export async function confirmOrderPaymentAction(orderId: string) {
  const { tenantId, user, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "payments:confirm");
  try {
    await confirmOrderPayment(tenantId, orderId, user.id);
    revalidatePath("/dashboard/payments");
  } catch (e) {
    return domainErrorValue(e);
  }
}

export async function rejectOrderPaymentAction(orderId: string, formData: FormData) {
  const { tenantId, user, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "payments:confirm");
  try {
    await rejectOrderPayment(tenantId, orderId, user.id, formData.get("reason") ? String(formData.get("reason")) : undefined);
    revalidatePath("/dashboard/payments");
  } catch (e) {
    return domainErrorValue(e);
  }
}
