"use server";
import { revalidatePath } from "next/cache";
import { requireStaffPermission } from "../staff-permission";
import { createStaff, setStaffRole, deactivateStaff, type StaffRoleKey } from "@/server/auth/staff";
import { actionAudit } from "@/server/audit/action-context";

export async function createStaffAction(formData: FormData) {
  const ctx = await requireStaffPermission();
  const roleKey: StaffRoleKey = formData.get("roleKey") === "manager" ? "manager" : "staff";
  await createStaff(ctx.tenantId, {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim() || undefined,
    phone: String(formData.get("phone") || "").trim() || undefined,
    password: String(formData.get("password") || ""),
    roleKey,
  }, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/staff");
}

export async function setStaffRoleAction(userId: string, roleKey: StaffRoleKey) {
  const ctx = await requireStaffPermission();
  await setStaffRole(ctx.tenantId, userId, roleKey, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/staff");
}

export async function deactivateStaffAction(userId: string) {
  const ctx = await requireStaffPermission();
  await deactivateStaff(ctx.tenantId, userId, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/staff");
}
