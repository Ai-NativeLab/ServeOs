"use server";
import { revalidatePath } from "next/cache";
import { requirePurchasingPermission, resolvePurchasingActor } from "../purchasing-permission";
import { createSupplier } from "@/server/purchasing/suppliers";

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
    return { error: e instanceof Error ? e.message : "Could not create supplier." };
  }
  revalidatePath("/dashboard/suppliers");
}
