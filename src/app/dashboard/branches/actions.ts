"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardUser } from "@/server/auth/dashboard-context";
import { authorize } from "@/server/rbac/authorize";
import { createBranch, updateBranch, deleteBranch } from "@/server/branches/service";

async function getCtx() {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "menu:manage");
  return ctx;
}

export async function createBranchAction(formData: FormData) {
  const { tenantId } = await getCtx();
  await createBranch(tenantId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  });
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function updateBranchAction(branchId: string, formData: FormData) {
  const { tenantId } = await getCtx();
  await updateBranch(tenantId, branchId, {
    name: String(formData.get("name")),
    address: formData.get("address") ? String(formData.get("address")) : undefined,
    phone: formData.get("phone") ? String(formData.get("phone")) : undefined,
  });
  revalidatePath("/dashboard/branches");
  redirect("/dashboard/branches");
}

export async function deleteBranchAction(branchId: string) {
  const { tenantId } = await getCtx();
  await deleteBranch(tenantId, branchId);
  revalidatePath("/dashboard/branches");
}
