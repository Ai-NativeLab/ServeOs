"use server";
import { revalidatePath } from "next/cache";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { updateBranchOrdering, createDeliveryArea, deleteDeliveryArea } from "@/server/branches/service";
import { updateTaxSettings } from "@/server/tenancy/settings";
import { actionAudit } from "@/server/audit/action-context";
import type { OpeningHours } from "@/server/branches/schema";

export async function setAcceptingOrdersAction(branchId: string, accepting: boolean) {
  const ctx = await requireFulfillmentPermission();
  await updateBranchOrdering(ctx.tenantId, branchId, { acceptingOrders: accepting }, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function setOpeningHoursAction(branchId: string, formData: FormData) {
  const ctx = await requireFulfillmentPermission();
  const hours: OpeningHours = [];
  for (let day = 0; day < 7; day++) {
    const closed = formData.get(`closed-${day}`) === "on";
    hours.push({ day, closed, open: String(formData.get(`open-${day}`) || "10:00"), close: String(formData.get(`close-${day}`) || "23:00") });
  }
  await updateBranchOrdering(ctx.tenantId, branchId, { openingHours: hours }, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function addAreaAction(branchId: string, formData: FormData) {
  const ctx = await requireFulfillmentPermission();
  await createDeliveryArea(ctx.tenantId, branchId, {
    nameEn: String(formData.get("nameEn")), nameAr: String(formData.get("nameAr")),
    deliveryFee: String(formData.get("deliveryFee") || "0"), minOrderAmount: String(formData.get("minOrderAmount") || "0"),
    etaMinutes: formData.get("etaMinutes") ? Number(formData.get("etaMinutes")) : null,
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function deleteAreaAction(areaId: string) {
  const ctx = await requireFulfillmentPermission();
  await deleteDeliveryArea(ctx.tenantId, areaId, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/fulfillment");
}

export async function setVatAction(formData: FormData) {
  const ctx = await requireFulfillmentPermission();
  await updateTaxSettings(ctx.tenantId, { vatRate: Number(formData.get("vatRate")) }, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/fulfillment");
}
