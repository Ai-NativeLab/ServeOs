"use server";
import { revalidatePath } from "next/cache";
import { requireCustomersPermission } from "../customers-permission";
import { actionAudit } from "@/server/audit/action-context";
import { setTradeApproval } from "@/server/customers/service";

export async function setTradeApprovalAction(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const ctx = await requireCustomersPermission();
  const customerId = String(formData.get("customerId") ?? "");
  const approved = formData.get("approved") === "true";
  const discountPercent = approved ? Number(formData.get("discountPercent") ?? 0) : undefined;

  try {
    await setTradeApproval(ctx.tenantId, customerId, { approved, discountPercent }, await actionAudit(ctx));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not update trade account." };
  }
  revalidatePath("/dashboard/customers");
  return {};
}
