"use server";
import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { getTenantById, setVatEnabled, setVatRate, setPricesIncludeVat, setServiceChargeRate } from "@/server/tenancy";
import { getCapabilities, selectStorefrontTemplate, type VerticalId } from "@/server/verticals";

export async function saveTaxSettingsAction(formData: FormData) {
  const { tenantId, roleKeys } = await requireDashboardUser();
  authorize(roleKeys, "fulfillment:manage");
  const tenant = await getTenantById(tenantId);
  const caps = getCapabilities(selectStorefrontTemplate(tenant?.vertical as VerticalId));

  await setVatEnabled(tenantId, formData.get("vatEnabled") === "true");
  const rate = Number(formData.get("vatRate"));
  if (!Number.isNaN(rate) && rate >= 0 && rate <= 100) await setVatRate(tenantId, rate);
  await setPricesIncludeVat(tenantId, formData.get("pricesIncludeVat") === "true");

  if (caps.serviceCharge) {
    const sc = formData.get("serviceChargeRate");
    await setServiceChargeRate(tenantId, sc !== null && sc !== "" ? Number(sc) : null);
  }
  revalidatePath("/dashboard/settings/taxes");
}
