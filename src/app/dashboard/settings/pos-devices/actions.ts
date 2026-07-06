"use server";
import { revalidatePath } from "next/cache";
import { requireTenantManagePermission } from "../profile-permission";
import { createPairingCode, revokeDevice } from "@/server/pos/service";

export async function generatePairingCodeAction(
  formData: FormData,
): Promise<{ code: string; expiresAt: Date } | { error: string }> {
  const { tenantId, user } = await requireTenantManagePermission();
  const branchId = String(formData.get("branchId") || "").trim();
  const label = String(formData.get("label") || "").trim();
  if (!branchId) return { error: "Select a branch" };
  if (!label) return { error: "Enter a label" };

  const res = await createPairingCode(tenantId, branchId, label, user.id);
  revalidatePath("/dashboard/settings/pos-devices");
  return { code: res.code, expiresAt: res.expiresAt };
}

export async function revokeDeviceAction(deviceId: string): Promise<void> {
  const { tenantId } = await requireTenantManagePermission();
  await revokeDevice(tenantId, deviceId);
  revalidatePath("/dashboard/settings/pos-devices");
}
