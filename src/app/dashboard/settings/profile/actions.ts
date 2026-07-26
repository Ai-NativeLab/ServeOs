"use server";
import { revalidatePath } from "next/cache";
import { requireTenantManagePermission } from "../profile-permission";
import { updateTenantProfile } from "@/server/tenancy";
import { actionAudit } from "@/server/audit/action-context";

export async function updateTenantProfileAction(formData: FormData) {
  const ctx = await requireTenantManagePermission();
  await updateTenantProfile(ctx.tenantId, {
    name: String(formData.get("name") || "").trim(),
    tagline: String(formData.get("tagline") || "").trim() || null,
    cuisine: String(formData.get("cuisine") || "").trim() || null,
    logoUrl: String(formData.get("logoUrl") || "").trim() || null,
    coverImageUrl: String(formData.get("coverImageUrl") || "").trim() || null,
    primaryColor: String(formData.get("primaryColor") || "#0F172A"),
    defaultLocale: String(formData.get("defaultLocale") || "ar"),
    timezone: String(formData.get("timezone") || "Africa/Cairo"),
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/profile");
  revalidatePath("/dashboard"); // sidebar restaurant name reads from the layout
}
