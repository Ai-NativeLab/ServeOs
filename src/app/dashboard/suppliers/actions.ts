"use server";

import { revalidatePath } from "next/cache";
import { requirePurchasingPermission, resolvePurchasingActor } from "../purchasing-permission";
import { domainErrorValue } from "../action-errors";
import {
  createSupplier,
  updateSupplier,
  upsertSupplierItem,
  type UpdateSupplierInput,
} from "@/server/purchasing/suppliers";
import type { UnitOfMeasure } from "@/server/catalog/uom";

export async function createSupplierAction(formData: FormData): Promise<void | { error: string }> {
  const ctx = await requirePurchasingPermission("suppliers:manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "name is required" };
  try {
    await createSupplier(await resolvePurchasingActor(ctx), {
      name,
      contactName: String(formData.get("contactName") ?? "") || undefined,
      email: String(formData.get("email") ?? "") || undefined,
      phone: String(formData.get("phone") ?? "") || undefined,
      paymentTerms: String(formData.get("paymentTerms") ?? "") || undefined,
    });
  } catch (e) {
    return domainErrorValue(e);
  }
  revalidatePath("/dashboard/suppliers");
}

export async function updateSupplierAction(
  supplierId: string,
  input: UpdateSupplierInput,
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("suppliers:manage");
    const actor = await resolvePurchasingActor(ctx);
    await updateSupplier(actor, supplierId, input);

    revalidatePath("/dashboard/suppliers");
    revalidatePath(`/dashboard/suppliers/${supplierId}`);
    return { success: true };
  } catch (e) {
    return domainErrorValue(e);
  }
}

export async function upsertSupplierItemAction(
  supplierId: string,
  data: {
    itemId: string;
    supplierSku?: string | null;
    lastUnitCost?: number;
    packUom?: UnitOfMeasure;
  },
): Promise<{ error: string } | { success: true }> {
  try {
    const ctx = await requirePurchasingPermission("suppliers:manage");
    if (!data.itemId) return { error: "Item is required" };
    if (data.lastUnitCost !== undefined
      && (!Number.isFinite(Number(data.lastUnitCost)) || Number(data.lastUnitCost) < 0)) {
      return { error: "Unit cost must be a non-negative number" };
    }

    const actor = await resolvePurchasingActor(ctx);
    await upsertSupplierItem(actor, {
      supplierId,
      itemId: data.itemId,
      supplierSku: data.supplierSku?.trim() || undefined,
      lastUnitCost: data.lastUnitCost !== undefined ? Number(data.lastUnitCost) : undefined,
      packUom: data.packUom || undefined,
    });

    revalidatePath(`/dashboard/suppliers/${supplierId}`);
    return { success: true };
  } catch (e) {
    return domainErrorValue(e);
  }
}
