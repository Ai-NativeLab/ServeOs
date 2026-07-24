import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { invoices, type Invoice } from "./schema";
import { plans, subscriptions } from "@/server/subscription/schema";
import { activateSubscriptionForPlan } from "@/server/subscription/service";
import { PaymentAlreadyResolvedError } from "@/server/payments/offline";

/** invoices is a control table (like subscriptions/plans) → plain db, matching ManualBillingProvider. */
export async function listInvoicesForTenant(tenantId: string): Promise<Invoice[]> {
  return db.select().from(invoices).where(eq(invoices.tenantId, tenantId)).orderBy(desc(invoices.createdAt));
}

/** Open a new invoice for the tenant's monthly plan price against its existing subscription. */
export async function createPlanInvoice(tenantId: string, planId: string): Promise<Invoice> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) throw new Error("Unknown plan");
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).limit(1);
  if (!sub) throw new Error("No subscription");
  const [inv] = await db.insert(invoices).values({
    tenantId, subscriptionId: sub.id, planId: plan.id,
    amount: (Math.round(Number(plan.priceMonthly) * 100) / 100).toFixed(2),
    currency: plan.currency, status: "open", method: null,
  }).returning();
  return inv;
}

/** Tenant submits payment proof (reference and/or screenshot) — open → pending_verification. */
export async function submitInvoiceProof(tenantId: string, invoiceId: string, proof: { reference: string | null; screenshotUrl: string | null }): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "pending_verification", paymentReference: proof.reference, paymentProofUrl: proof.screenshotUrl })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), eq(invoices.status, "open")))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  return inv;
}

/** Admin confirms proof — pending_verification → paid, then activates the subscription onto the invoice's plan. */
export async function confirmInvoice(tenantId: string, invoiceId: string, adminUserId: string): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "paid", method: "manual", markedBy: adminUserId, paidAt: new Date() })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), eq(invoices.status, "pending_verification")))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  // Only plan invoices (created via createPlanInvoice) carry a planId — activate
  // the subscription onto it. Invoices created via the generic BillingProvider
  // interface have no associated plan to activate.
  if (inv.planId) await activateSubscriptionForPlan(tenantId, inv.planId);
  return inv;
}

/** Admin rejects proof — pending_verification → void. */
export async function rejectInvoice(tenantId: string, invoiceId: string): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "void" })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), eq(invoices.status, "pending_verification")))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  return inv;
}
