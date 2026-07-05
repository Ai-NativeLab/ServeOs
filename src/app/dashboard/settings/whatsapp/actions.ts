"use server";
import { revalidatePath } from "next/cache";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { setWhatsappNumber } from "@/server/tenancy/settings";

export async function setWhatsappNumberAction(formData: FormData) {
  const { tenantId } = await requireFulfillmentPermission();
  const raw = String(formData.get("whatsappNumber") || "").trim();
  await setWhatsappNumber(tenantId, raw === "" ? null : raw);
  revalidatePath("/dashboard/settings/whatsapp");
}
