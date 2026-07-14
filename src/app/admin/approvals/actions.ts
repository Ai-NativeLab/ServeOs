// src/app/admin/approvals/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { approveTenant, rejectTenant } from "@/server/platform";

export async function approveAction(formData: FormData) {
  const admin = await requireSuperAdmin();
  await approveTenant(String(formData.get("tenantId")), admin.id);
  revalidatePath("/admin/approvals");
}

export async function rejectAction(formData: FormData) {
  const admin = await requireSuperAdmin();
  await rejectTenant(String(formData.get("tenantId")), admin.id, String(formData.get("notes") ?? ""));
  revalidatePath("/admin/approvals");
}
