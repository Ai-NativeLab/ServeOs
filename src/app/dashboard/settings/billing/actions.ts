"use server";
import { revalidatePath } from "next/cache";
import { requireBillingPermission } from "../billing-permission";
import { requestPlanUpgrade } from "@/server/tenancy/settings";
import { createPlanInvoice, submitInvoiceProof, listInvoicesForTenant } from "@/server/billing/service";
import { OutstandingInvoiceExistsError } from "@/server/billing/errors";
import type { Invoice } from "@/server/billing/schema";

export async function requestUpgradeAction(planKey: string) {
  const { tenantId } = await requireBillingPermission();
  await requestPlanUpgrade(tenantId, planKey);
  revalidatePath("/dashboard/settings/billing");
}

const OUTSTANDING_STATUSES = new Set<Invoice["status"]>(["open", "pending_verification"]);

export async function subscribeToPlanAction(planId: string) {
  const { tenantId } = await requireBillingPermission();
  // Guard: never open a second plan invoice while one is still open or
  // pending_verification — otherwise an admin could later confirm the wrong
  // (out-of-order) invoice and mis-set the plan. See Task 10 brief.
  const existing = await listInvoicesForTenant(tenantId);
  if (existing.some((inv) => OUTSTANDING_STATUSES.has(inv.status))) {
    throw new OutstandingInvoiceExistsError();
  }
  await createPlanInvoice(tenantId, planId);
  revalidatePath("/dashboard/settings/billing");
}

export async function submitInvoiceProofAction(invoiceId: string, formData: FormData) {
  const { tenantId } = await requireBillingPermission();
  await submitInvoiceProof(tenantId, invoiceId, {
    reference: formData.get("reference") ? String(formData.get("reference")) : null,
    screenshotUrl: formData.get("screenshotUrl") ? String(formData.get("screenshotUrl")) : null,
  });
  revalidatePath("/dashboard/settings/billing");
}
