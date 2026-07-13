"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { approveTenant, rejectTenant } from "@/server/platform";
import { invalidateSession } from "@/server/auth";
import { SESSION_COOKIE } from "@/server/auth/current-user";

export async function approveAction(formData: FormData) {
  const admin = await requireSuperAdmin();
  await approveTenant(String(formData.get("tenantId")), admin.id);
  revalidatePath("/admin");
}

export async function rejectAction(formData: FormData) {
  const admin = await requireSuperAdmin();
  await rejectTenant(String(formData.get("tenantId")), admin.id, String(formData.get("notes") ?? ""));
  revalidatePath("/admin");
}

export async function adminSignOutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await invalidateSession(token);
  jar.delete(SESSION_COOKIE);
  redirect("/admin/login");
}
