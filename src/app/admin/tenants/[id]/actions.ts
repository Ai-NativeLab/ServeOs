// src/app/admin/tenants/[id]/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { cancelSubscription, forceSubscriptionActive, markSubscriptionPaid, suspendTenant } from "@/server/platform";

async function withAdmin(tenantId: string, fn: (adminId: string) => Promise<void>): Promise<void> {
  const admin = await requireSuperAdmin();
  await fn(admin.id);
  revalidatePath(`/admin/tenants/${tenantId}`);
}

export async function cancelSubscriptionAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => cancelSubscription(tenantId, adminId));
}

export async function forceActiveAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => forceSubscriptionActive(tenantId, adminId));
}

export async function markPaidAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => markSubscriptionPaid(tenantId, adminId));
}

export async function suspendTenantAction(tenantId: string) {
  await withAdmin(tenantId, (adminId) => suspendTenant(tenantId, adminId));
}
