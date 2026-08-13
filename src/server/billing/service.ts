import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { invoices, type Invoice } from "./schema";
import { plans, subscriptions } from "@/server/subscription/schema";
import { activateSubscriptionForPlan } from "@/server/subscription/service";
import { PaymentAlreadyResolvedError, InvalidProofError } from "@/server/payments/offline";
import { sanitizeHttpUrl } from "@/lib/safe-url";
import { OutstandingInvoiceExistsError } from "./errors";
import { tenants } from "@/server/tenancy/schema";

/** Postgres unique-violation error code. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code ?? (err as { cause?: { code?: unknown } }).cause?.code;
  return code === UNIQUE_VIOLATION;
}

/** invoices is a control table (like subscriptions/plans) → plain db, matching ManualBillingProvider. */
export async function listInvoicesForTenant(tenantId: string): Promise<Invoice[]> {
  return db.select().from(invoices).where(eq(invoices.tenantId, tenantId)).orderBy(desc(invoices.createdAt));
}

/** Open a new invoice for the tenant's monthly plan price against its existing subscription.
 *
 * The `subscribeToPlanAction` pre-check (list-then-create) is racy under
 * concurrent double-submit, so this is backstopped by a partial unique index
 * (invoices_one_outstanding_per_tenant, see ./schema.ts) that allows at most
 * one open/pending_verification invoice per tenant. A violation here means
 * another request won the race — surface it as the same domain error the
 * pre-check would have thrown. */
export async function createPlanInvoice(tenantId: string, planId: string): Promise<Invoice> {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan) throw new Error("Unknown plan");
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId)).limit(1);
  if (!sub) throw new Error("No subscription");
  try {
    const [inv] = await db.insert(invoices).values({
      tenantId, subscriptionId: sub.id, planId: plan.id,
      amount: (Math.round(Number(plan.priceMonthly) * 100) / 100).toFixed(2),
      currency: plan.currency, status: "open", method: null,
    }).returning();
    return inv;
  } catch (err) {
    if (isUniqueViolation(err)) throw new OutstandingInvoiceExistsError();
    throw err;
  }
}

/** Tenant submits payment proof (reference and/or screenshot) — open → pending_verification. */
export async function submitInvoiceProof(tenantId: string, invoiceId: string, proof: { reference: string | null; screenshotUrl: string | null }): Promise<Invoice> {
  // Sanitize before the empty-check: a javascript:/data: screenshotUrl sanitizes to
  // null, so a submission with no reference and only such a URL is correctly
  // treated as "no proof" rather than silently persisted as stored XSS.
  const screenshotUrl = sanitizeHttpUrl(proof.screenshotUrl);
  if (!proof.reference?.trim() && !screenshotUrl) {
    throw new InvalidProofError();
  }
  const [inv] = await db.update(invoices)
    .set({ status: "pending_verification", paymentReference: proof.reference, paymentProofUrl: screenshotUrl })
    .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId), eq(invoices.status, "open")))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  return inv;
}

/**
 * Admin marks an invoice paid and activates the subscription onto its plan.
 *
 * Accepts `open` as well as `pending_verification`, because a rep closing a
 * plan on the phone never passes through the proof step at all — the tenant
 * asked, someone called them, money changed hands off-platform. Restricting
 * this to `pending_verification` would leave every phone sale stuck.
 *
 * Both are terminal-guarded in the WHERE, so a `paid` or `void` invoice still
 * can't be re-confirmed, and two admins clicking at once still produce exactly
 * one winner.
 */
export async function confirmInvoice(tenantId: string, invoiceId: string, adminUserId: string): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "paid", method: "manual", markedBy: adminUserId, paidAt: new Date() })
    .where(and(
      eq(invoices.id, invoiceId),
      eq(invoices.tenantId, tenantId),
      inArray(invoices.status, ["open", "pending_verification"]),
    ))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  // Only plan invoices (created via createPlanInvoice) carry a planId — activate
  // the subscription onto it. Invoices created via the generic BillingProvider
  // interface have no associated plan to activate.
  if (inv.planId) await activateSubscriptionForPlan(tenantId, inv.planId);
  return inv;
}

/**
 * Admin voids an invoice — a rejected proof, or a plan request that came to
 * nothing. Voiding also clears the partial unique index, so the tenant can ask
 * again rather than being stuck behind a dead request forever.
 */
export async function rejectInvoice(tenantId: string, invoiceId: string): Promise<Invoice> {
  const [inv] = await db.update(invoices)
    .set({ status: "void" })
    .where(and(
      eq(invoices.id, invoiceId),
      eq(invoices.tenantId, tenantId),
      inArray(invoices.status, ["open", "pending_verification"]),
    ))
    .returning();
  if (!inv) throw new PaymentAlreadyResolvedError();
  return inv;
}

/**
 * Platform admin work queue — every invoice a human still has to act on,
 * newest first, across all tenants.
 *
 * Both states belong here and they mean different things:
 *   `open`                 a tenant asked for a plan; a rep needs to call them
 *   `pending_verification` a tenant says they have paid; someone must check
 *
 * `open` used to be invisible here, so a tenant asking for a paid plan
 * produced a row nobody ever looked at. That was survivable while the tenant
 * could self-serve; it is not, now that a rep closing the sale IS the flow.
 *
 * invoices is a control table with no RLS, which is what makes this
 * cross-tenant read possible at all — the same query against tenant_settings
 * (where upgradeRequest lives) would return nothing, because that table has
 * FORCE ROW LEVEL SECURITY.
 */
export async function listInvoicesNeedingAction() {
  return db.select({
    id: invoices.id, tenantId: invoices.tenantId, status: invoices.status,
    amount: invoices.amount, currency: invoices.currency,
    reference: invoices.paymentReference, proofUrl: invoices.paymentProofUrl, createdAt: invoices.createdAt,
    tenantName: tenants.name, planName: plans.name,
  }).from(invoices)
    .innerJoin(tenants, eq(tenants.id, invoices.tenantId))
    .leftJoin(plans, eq(plans.id, invoices.planId))
    .where(inArray(invoices.status, ["open", "pending_verification"]))
    .orderBy(desc(invoices.createdAt));
}

/** @deprecated Use listInvoicesNeedingAction — kept for the existing tests. */
export async function listInvoicesPendingVerification() {
  return db.select({
    id: invoices.id, tenantId: invoices.tenantId, amount: invoices.amount, currency: invoices.currency,
    reference: invoices.paymentReference, proofUrl: invoices.paymentProofUrl, createdAt: invoices.createdAt,
    tenantName: tenants.name,
  }).from(invoices).innerJoin(tenants, eq(tenants.id, invoices.tenantId))
    .where(eq(invoices.status, "pending_verification")).orderBy(desc(invoices.createdAt));
}
