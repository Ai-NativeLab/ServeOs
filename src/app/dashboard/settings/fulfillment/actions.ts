"use server";
import { revalidatePath } from "next/cache";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { updateBranchOrdering, createDeliveryArea, deleteDeliveryArea } from "@/server/branches/service";
import { setVatRate } from "@/server/tenancy/settings";
import type { OpeningHours } from "@/server/branches/schema";

export async function setAcceptingOrdersAction(branchId: string, accepting: boolean) {
  const { tenantId } = await requireFulfillmentPermission();
  await updateBranchOrdering(tenantId, branchId, { acceptingOrders: accepting });
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function setOpeningHoursAction(branchId: string, formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  const hours: OpeningHours = [];
  for (let day = 0; day < 7; day++) {
    const closed = formData.get(`closed-${day}`) === "on";
    hours.push({ day, closed, open: String(formData.get(`open-${day}`) || "10:00"), close: String(formData.get(`close-${day}`) || "23:00") });
  }
  await updateBranchOrdering(tenantId, branchId, { openingHours: hours });
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function addAreaAction(branchId: string, formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  await createDeliveryArea(tenantId, branchId, {
    nameEn: String(formData.get("nameEn")), nameAr: String(formData.get("nameAr")),
    deliveryFee: String(formData.get("deliveryFee") || "0"), minOrderAmount: String(formData.get("minOrderAmount") || "0"),
    etaMinutes: formData.get("etaMinutes") ? Number(formData.get("etaMinutes")) : null,
  });
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function deleteAreaAction(areaId: string) {
  const { tenantId } = await requireFulfillmentPermission();
  await deleteDeliveryArea(tenantId, areaId);
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function setVatAction(formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  await setVatRate(tenantId, Number(formData.get("vatRate")));
  revalidatePath("/dashboard/settings/fulfillment");
}
