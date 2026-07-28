"use server";
import { revalidatePath } from "next/cache";
import { requireMenuPermission } from "../menu-permission";
import { createBanner, updateBanner, deleteBanner } from "@/server/banners/service";
import { actionAudit } from "@/server/audit/action-context";

export async function createBannerAction(formData: FormData) {
  const ctx = await requireMenuPermission();
  await createBanner(ctx.tenantId, {
    imageUrl: String(formData.get("imageUrl")),
    titleEn: formData.get("titleEn") ? String(formData.get("titleEn")) : undefined,
    titleAr: formData.get("titleAr") ? String(formData.get("titleAr")) : undefined,
    linkUrl: formData.get("linkUrl") ? String(formData.get("linkUrl")) : undefined,
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/banners");
}

export async function toggleBannerAction(bannerId: string, isActive: boolean) {
  const ctx = await requireMenuPermission();
  await updateBanner(ctx.tenantId, bannerId, { isActive }, await actionAudit(ctx));
  revalidatePath("/dashboard/banners");
}

export async function deleteBannerAction(bannerId: string) {
  const ctx = await requireMenuPermission();
  await deleteBanner(ctx.tenantId, bannerId, await actionAudit(ctx));
  revalidatePath("/dashboard/banners");
}
