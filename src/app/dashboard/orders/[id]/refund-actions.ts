"use server";
import { revalidatePath } from "next/cache";
import { requireOrdersPermission } from "../../orders-permission";
import { authorize } from "@/server/rbac/authorize";
import { ROLE_PERMISSIONS } from "@/server/rbac/permissions";
import { getOrder } from "@/server/ordering/service";
import { issueRefund, type RefundInput } from "@/server/pos/refund";

export async function issueRefundAction(input: RefundInput) {
  const { tenantId, user, roleKeys } = await requireOrdersPermission();
  authorize(roleKeys, "pos:refund"); // owner + manager hold it; dashboard needs no grant token
  const permissions = roleKeys.flatMap((rk) => ROLE_PERMISSIONS[rk] ?? []);
  // Branch attribution comes from the order we loaded, never from the client —
  // a caller could otherwise attribute a refund to another tenant's branch.
  const order = await getOrder(tenantId, input.orderId);
  await issueRefund({ tenantId, branchId: order.branchId, actorUserId: user.id, permissions }, input);
  revalidatePath(`/dashboard/orders/${input.orderId}`);
}
