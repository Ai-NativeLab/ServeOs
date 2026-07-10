"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMenuPermission } from "../../menu-permission";
import {
  createProduct,
  updateProduct,
  deleteProduct,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertModifierOption,
  deleteModifierOption,
  setBranchAvailability,
} from "@/server/catalog/service";

export async function createProductAction(formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await createProduct(tenantId, {
    categoryId: String(formData.get("categoryId")),
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
    imageUrl: formData.get("imageUrl") ? String(formData.get("imageUrl")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateProductAction(productId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  const isPublished = formData.get("isPublished") === "true";
  const isFeatured = formData.get("isFeatured") === "true";
  await updateProduct(tenantId, productId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
    imageUrl: formData.get("imageUrl") ? String(formData.get("imageUrl")) : null,
    isPublished,
    isFeatured,
  });
  revalidatePath("/dashboard/menu");
  redirect(`/dashboard/menu/products/${productId}`);
}

export async function deleteProductAction(productId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteProduct(tenantId, productId);
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function upsertModifierGroupAction(productId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await upsertModifierGroup(tenantId, productId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    required: formData.get("required") === "true",
    minSelections: Number(formData.get("minSelections") ?? 0),
    maxSelections: Number(formData.get("maxSelections") ?? 1),
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteModifierGroupAction(productId: string, groupId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteModifierGroup(tenantId, groupId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function upsertModifierOptionAction(productId: string, groupId: string, formData: FormData) {
  const { tenantId } = await requireMenuPermission();
  await upsertModifierOption(tenantId, groupId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    priceDelta: String(formData.get("priceDelta") ?? "0"),
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteModifierOptionAction(productId: string, optionId: string) {
  const { tenantId } = await requireMenuPermission();
  await deleteModifierOption(tenantId, optionId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function setBranchAvailabilityAction(
  productId: string,
  branchId: string,
  available: boolean,
  priceOverride?: number,
) {
  const { tenantId } = await requireMenuPermission();
  await setBranchAvailability(tenantId, branchId, productId, available, priceOverride);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}
