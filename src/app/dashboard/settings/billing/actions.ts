"use server";
import { revalidatePath } from "next/cache";
import { requireBillingPermission } from "../billing-permission";
import { requestPlanUpgrade } from "@/server/tenancy/settings";

export async function requestUpgradeAction(planKey: string) {
  const { tenantId } = await requireBillingPermission();
  await requestPlanUpgrade(tenantId, planKey);
  revalidatePath("/dashboard/settings/billing");
}
