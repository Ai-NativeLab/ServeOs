"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireOrdersPermission } from "../../orders-permission";
import { domainErrorValue } from "../../action-errors";
import { transitionStatus, markPaid } from "@/server/ordering/service";
import { headersFingerprint } from "@/server/audit/fingerprint";
import type { OrderStatus } from "@/server/ordering/schema";

export async function transitionOrderAction(orderId: string, to: OrderStatus, reason?: string) {
  try {
    const { tenantId, user } = await requireOrdersPermission();
    await transitionStatus(tenantId, orderId, to, user.id, reason, { fingerprint: headersFingerprint(await headers()) });
    revalidatePath(`/dashboard/orders/${orderId}`);
    revalidatePath("/dashboard/orders");
  } catch (e) {
    // #165/#187 C5: PaymentNotVerifiedError (and every other domain refusal)
    // must reach the kitchen as a readable message — never as the crash toast.
    return domainErrorValue(e);
  }
}

export async function markPaidAction(orderId: string) {
  try {
    const { tenantId, user } = await requireOrdersPermission();
    await markPaid(tenantId, orderId, user.id, { fingerprint: headersFingerprint(await headers()) });
    revalidatePath(`/dashboard/orders/${orderId}`);
  } catch (e) {
    return domainErrorValue(e);
  }
}
