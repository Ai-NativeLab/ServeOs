"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getTenantById } from "@/server/tenancy";
import { updateTaxSettings, type TaxSettingsPatch } from "@/server/tenancy/settings";
import { getCapabilities, selectStorefrontTemplate, type VerticalId } from "@/server/verticals";
import { actionAudit } from "@/server/audit/action-context";

export async function saveTaxSettingsAction(formData: FormData) {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "fulfillment:manage");
  const tenant = await getTenantById(ctx.tenantId);
  const caps = getCapabilities(selectStorefrontTemplate(tenant?.vertical as VerticalId));

  const rate = Number(formData.get("vatRate"));
  const patch: TaxSettingsPatch = {
    vatEnabled: formData.get("vatEnabled") === "true",
    pricesIncludeVat: formData.get("pricesIncludeVat") === "true",
    ...(!Number.isNaN(rate) && rate >= 0 && rate <= 100 ? { vatRate: rate } : {}),
  };
  if (caps.serviceCharge) {
    const sc = formData.get("serviceChargeRate");
    patch.serviceChargeRate = sc !== null && sc !== "" ? Number(sc) : null;
  }
  await updateTaxSettings(ctx.tenantId, patch, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/taxes");
}
