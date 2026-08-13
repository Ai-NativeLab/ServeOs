"use server";
import { revalidatePath } from "next/cache";
import { requireBillingPermission } from "../billing-permission";
import { createPlanInvoice, listInvoicesForTenant } from "@/server/billing/service";
import { OutstandingInvoiceExistsError } from "@/server/billing/errors";
import type { Invoice } from "@/server/billing/schema";

const OUTSTANDING_STATUSES = new Set<Invoice["status"]>(["open", "pending_verification"]);

/**
 * A tenant asks for a plan. Sales-led: this raises the invoice that puts them
 * on the platform admin's work queue, and a rep calls to take payment and
 * activate it. Nothing about the subscription changes here.
 *
 * There is no card gateway (Paymob is decision D3 in docs/ROADMAP.md and
 * parked) and nothing that can observe an InstaPay or wallet transfer, so a
 * self-serve flow could only ever have asked the customer to type a reference
 * back to us and wait — which is a worse version of a phone call.
 */
export async function requestPlanAction(planId: string) {
  const { tenantId } = await requireBillingPermission();
  // Guard: never open a second plan invoice while one is still open or
  // pending_verification — otherwise an admin could later confirm the wrong
  // (out-of-order) invoice and mis-set the plan. Backstopped by a partial
  // unique index; see createPlanInvoice.
  const existing = await listInvoicesForTenant(tenantId);
  if (existing.some((inv) => OUTSTANDING_STATUSES.has(inv.status))) {
    throw new OutstandingInvoiceExistsError();
  }
  await createPlanInvoice(tenantId, planId);
  revalidatePath("/dashboard/settings/billing");
}
