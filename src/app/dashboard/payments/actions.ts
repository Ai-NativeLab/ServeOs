"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { confirmOrderPayment, rejectOrderPayment } from "@/server/ordering/service";

export async function confirmOrderPaymentAction(orderId: string) {
  const { tenantId, user, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "payments:confirm");
  await confirmOrderPayment(tenantId, orderId, user.id);
  revalidatePath("/dashboard/payments");
}

export async function rejectOrderPaymentAction(orderId: string, formData: FormData) {
  const { tenantId, user, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "payments:confirm");
  await rejectOrderPayment(tenantId, orderId, user.id, formData.get("reason") ? String(formData.get("reason")) : undefined);
  revalidatePath("/dashboard/payments");
}
