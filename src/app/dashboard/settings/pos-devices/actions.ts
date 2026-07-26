"use server";
import { revalidatePath } from "next/cache";
import { requireTenantManagePermission } from "../profile-permission";
import { createPairingCode, revokeDevice } from "@/server/pos/service";
import { actionAudit } from "@/server/audit/action-context";

export async function generatePairingCodeAction(
  formData: FormData,
): Promise<{ code: string; expiresAt: Date } | { error: string }> {
  const ctx = await requireTenantManagePermission();
  const branchId = String(formData.get("branchId") || "").trim();
  const label = String(formData.get("label") || "").trim();
  if (!branchId) return { error: "Select a branch" };
  if (!label) return { error: "Enter a label" };

  const res = await createPairingCode(ctx.tenantId, branchId, label, ctx.user.id, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/pos-devices");
  return { code: res.code, expiresAt: res.expiresAt };
}

export async function revokeDeviceAction(deviceId: string): Promise<void> {
  const ctx = await requireTenantManagePermission();
  await revokeDevice(ctx.tenantId, deviceId, await actionAudit(ctx));
  revalidatePath("/dashboard/settings/pos-devices");
}
