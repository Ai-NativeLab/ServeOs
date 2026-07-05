"use server";
import { revalidatePath } from "next/cache";
import { requireStaffPermission } from "../staff-permission";
import { createStaff, setStaffRole, deactivateStaff, type StaffRoleKey } from "@/server/auth/staff";

export async function createStaffAction(formData: FormData) {
  const { tenantId } = await requireStaffPermission();
  const roleKey: StaffRoleKey = formData.get("roleKey") === "manager" ? "manager" : "staff";
  await createStaff(tenantId, {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim() || undefined,
    phone: String(formData.get("phone") || "").trim() || undefined,
    password: String(formData.get("password") || ""),
    roleKey,
  });
  revalidatePath("/dashboard/settings/staff");
}

export async function setStaffRoleAction(userId: string, roleKey: StaffRoleKey) {
  const { tenantId } = await requireStaffPermission();
  await setStaffRole(tenantId, userId, roleKey);
  revalidatePath("/dashboard/settings/staff");
}

export async function deactivateStaffAction(userId: string) {
  const { tenantId } = await requireStaffPermission();
  await deactivateStaff(tenantId, userId);
  revalidatePath("/dashboard/settings/staff");
}
