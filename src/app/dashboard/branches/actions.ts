"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMenuPermission } from "../menu-permission";
import { createBranch, updateBranch, deleteBranch } from "@/server/branches/service";
import { actionAudit } from "@/server/audit/action-context";

export async function createBranchAction(formData: FormData) {
  const ctx = await requireMenuPermission();
  await createBranch(ctx.tenantId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function updateBranchAction(branchId: string, formData: FormData) {
  const ctx = await requireMenuPermission();
  await updateBranch(ctx.tenantId, branchId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function deleteBranchAction(branchId: string) {
  const ctx = await requireMenuPermission();
  await deleteBranch(ctx.tenantId, branchId, await actionAudit(ctx));
  revalidatePath("/dashboard/branches");
}
