import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "./service";

/**
 * The two sensitive reads that qualify today (see the spec's "what qualifies").
 * Each is a one-statement withTenant append — a read has no data write to bind
 * to. Own-data views (a customer's own order) never qualify and are not wired.
 *
 * Forward emissions land with later specs and are enforced by the coverage
 * guardrail (Task 10):
 *   - report.cross_cashier_sales_viewed — Spec 3 sales history / Spec 10 X-Z reports
 *   - data.exported                     — Spec 10 export
 */

/** A staff/manager/owner opened the financial analytics (revenue, AOV). */
export async function recordFinancialView(tenantId: string, actor: AuditActorInput): Promise<void> {
  await withTenant(tenantId, (tx) => recordAuditEvent(
    { tenantId, actorUserId: actor.actorUserId ?? null, fingerprint: actor.fingerprint },
    { action: "report.financial_viewed", entityType: "report", entityId: "financial",
      summary: "Financial report viewed", metadata: { roleKey: actor.roleKey ?? null }, actorType: actor.actorType ?? "user" },
    tx,
  ));
}

/** A staff/manager/owner opened a customer's order detail (name/phone/address).
 *  Records THAT PII was viewed — the field names, never a second copy of the values. */
export async function recordCustomerPiiView(tenantId: string, orderId: string, actor: AuditActorInput): Promise<void> {
  await withTenant(tenantId, (tx) => recordAuditEvent(
    { tenantId, actorUserId: actor.actorUserId ?? null, fingerprint: actor.fingerprint },
    { action: "customer.pii_viewed", entityType: "customer", entityId: orderId,
      summary: "Customer PII viewed",
      metadata: { fields: ["customerName", "customerPhone", "addressText"], roleKey: actor.roleKey ?? null },
      actorType: actor.actorType ?? "user" },
    tx,
  ));
}
