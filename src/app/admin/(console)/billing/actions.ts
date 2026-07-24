// src/app/admin/billing/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/server/auth/admin-context";
import { confirmInvoice, rejectInvoice } from "@/server/billing/service";

export async function confirmInvoiceAction(invoiceId: string, tenantId: string) {
  const admin = await requireSuperAdmin();
  await confirmInvoice(tenantId, invoiceId, admin.id);
  revalidatePath("/admin/billing");
}

export async function rejectInvoiceAction(invoiceId: string, tenantId: string) {
  await requireSuperAdmin();
  await rejectInvoice(tenantId, invoiceId);
  revalidatePath("/admin/billing");
}
