"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireOrdersPermission } from "../../orders-permission";
import { transitionStatus, markPaid } from "@/server/ordering/service";
import { headersFingerprint } from "@/server/audit/fingerprint";
import type { OrderStatus } from "@/server/ordering/schema";

export async function transitionOrderAction(orderId: string, to: OrderStatus, reason?: string) {
  const { tenantId, user } = await requireOrdersPermission();
  await transitionStatus(tenantId, orderId, to, user.id, reason, { fingerprint: headersFingerprint(await headers()) });
  revalidatePath(`/dashboard/orders/${orderId}`);
  revalidatePath("/dashboard/orders");
}

export async function markPaidAction(orderId: string) {
  const { tenantId, user } = await requireOrdersPermission();
  await markPaid(tenantId, orderId, user.id, { fingerprint: headersFingerprint(await headers()) });
  revalidatePath(`/dashboard/orders/${orderId}`);
}
