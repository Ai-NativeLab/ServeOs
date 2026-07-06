"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMenuPermission } from "../../menu-permission";
import { createCategory, updateCategory, deleteCategory } from "@/server/catalog/service";

export async function createCategoryAction(formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await createCategory(tenantId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
    imageUrl: formData.get("imageUrl") ? String(formData.get("imageUrl")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateCategoryAction(categoryId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await updateCategory(tenantId, categoryId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    imageUrl: formData.get("imageUrl") ? String(formData.get("imageUrl")) : null,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function deleteCategoryAction(categoryId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteCategory(tenantId, categoryId);
  revalidatePath("/dashboard/menu");
}
