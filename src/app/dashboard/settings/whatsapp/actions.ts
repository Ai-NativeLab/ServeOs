"use server";
import { revalidatePath } from "next/cache";
import { requireFulfillmentPermission } from "../fulfillment-permission";
import { setWhatsappNumber } from "@/server/tenancy/settings";
import { actionAudit } from "@/server/audit/action-context";

export async function setWhatsappNumberAction(formData: FormData) {
  const ctx = await requireFulfillmentPermission();
  const raw = String(formData.get("whatsappNumber") || "").trim();
  await setWhatsappNumber(ctx.tenantId, raw === "" ? null : raw, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/whatsapp");
}
