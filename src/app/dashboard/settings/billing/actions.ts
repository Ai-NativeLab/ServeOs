"use server";
import { revalidatePath } from "next/cache";
import { requireBillingPermission } from "../billing-permission";
import { requestPlanUpgrade } from "@/server/tenancy/settings";
import { actionAudit } from "@/server/audit/action-context";

export async function requestUpgradeAction(planKey: string) {
  const ctx = await requireBillingPermission();
  await requestPlanUpgrade(ctx.tenantId, planKey, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/billing");
}
