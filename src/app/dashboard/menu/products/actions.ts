"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
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

async function getCtx() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}

export async function createProductAction(formData: FormData) {
  const { tenantId } = await getCtx();
  await createProduct(tenantId, {
    categoryId: String(formData.get("categoryId")),
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
  });
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function updateProductAction(productId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  const isPublished = formData.get("isPublished") === "true";
  await updateProduct(tenantId, productId, {
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    basePrice: String(formData.get("basePrice")),
    descriptionEn: formData.get("descriptionEn") ? String(formData.get("descriptionEn")) : undefined,
    descriptionAr: formData.get("descriptionAr") ? String(formData.get("descriptionAr")) : undefined,
    isPublished,
  });
  revalidatePath("/dashboard/menu");
  redirect(`/dashboard/menu/products/${productId}`);
}

export async function deleteProductAction(productId: string) {
  const { tenantId } = await getCtx();
  await deleteProduct(tenantId, productId);
  revalidatePath("/dashboard/menu");
  redirect("/dashboard/menu");
}

export async function upsertModifierGroupAction(productId: string, formData: FormData) {
  const { tenantId } = await getCtx();
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
  const { tenantId } = await getCtx();
  await deleteModifierGroup(tenantId, groupId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function upsertModifierOptionAction(productId: string, groupId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  await upsertModifierOption(tenantId, groupId, {
    id: formData.get("id") ? String(formData.get("id")) : undefined,
    nameEn: String(formData.get("nameEn")),
    nameAr: String(formData.get("nameAr")),
    priceDelta: String(formData.get("priceDelta") ?? "0"),
  });
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function deleteModifierOptionAction(productId: string, optionId: string) {
  const { tenantId } = await getCtx();
  await deleteModifierOption(tenantId, optionId);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}

export async function setBranchAvailabilityAction(
  productId: string,
  branchId: string,
  available: boolean,
  priceOverride?: number,
) {
  const { tenantId } = await getCtx();
  await setBranchAvailability(tenantId, branchId, productId, available, priceOverride);
  revalidatePath(`/dashboard/menu/products/${productId}`);
}
