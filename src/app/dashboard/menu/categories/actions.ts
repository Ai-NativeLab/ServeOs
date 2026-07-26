"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMenuPermission } from "../../menu-permission";
import { createCategory, updateCategory, deleteCategory } from "@/server/catalog/service";
import { actionAudit } from "@/server/audit/action-context";

export async function createCategoryAction(formData: FormData) {
  const ctx = await requireMenuPermission();
  await createCategory(ctx.tenantId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
    imageUrl: formData.get("imageUrl") ? String(formData.get("imageUrl")) : undefined,
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateCategoryAction(categoryId: string, formData: FormData) {
  const ctx = await requireMenuPermission();
  await updateCategory(ctx.tenantId, categoryId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    imageUrl: formData.get("imageUrl") ? String(formData.get("imageUrl")) : null,
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function deleteCategoryAction(categoryId: string) {
  const ctx = await requireMenuPermission();
  await deleteCategory(ctx.tenantId, categoryId, await actionAudit(ctx));
  revalidatePath("/dashboard/menu");
}
