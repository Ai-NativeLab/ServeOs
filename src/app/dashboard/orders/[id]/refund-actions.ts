"use server";
import { revalidatePath } from "next/cache";
import { requireOrdersPermission } from "../../orders-permission";
import { authorize } from "@/server/rbac/authorize";
import { ROLE_PERMISSIONS } from "@/server/rbac/permissions";
import { issueRefund, type RefundInput } from "@/server/pos/refund";

export async function issueRefundAction(input: RefundInput & { branchId: string }) {
  const { tenantId, user, roleKeys } = await requireOrdersPermission();
  authorize(roleKeys, "pos:refund"); // owner + manager hold it; dashboard needs no grant token
  const permissions = roleKeys.flatMap((rk) => ROLE_PERMISSIONS[rk] ?? []);
  await issueRefund({ tenantId, branchId: input.branchId, actorUserId: user.id, permissions }, input);
  revalidatePath(`/dashboard/orders/${input.orderId}`);
}
