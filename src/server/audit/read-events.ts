import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "./service";

/**
 * The sensitive reads that qualify today (see the spec's "what qualifies").
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

/**
 * A signed-in cashier pulled the branch's POS auth roster: scrypt hashes for
 * every POS-capable user, managers/owners included (accepted risk — see the
 * offline-sync design spec's threat model: any paired device with a signed-in
 * cashier can pull hashes for the whole roster, which is why the endpoint
 * requires requirePosCashier, not just a device token). Records that the bulk
 * credential read happened and which accounts were exposed to which device —
 * exactly what device revocation / password-rotation triage needs — never the
 * hashes themselves.
 */
export async function recordRosterSynced(
  tenantId: string,
  userIds: string[],
  actor: AuditActorInput,
): Promise<void> {
  await withTenant(tenantId, (tx) => recordAuditEvent(
    { tenantId, actorUserId: actor.actorUserId ?? null, fingerprint: actor.fingerprint },
    { action: "auth.roster_synced", entityType: "auth", entityId: "roster",
      summary: `POS auth roster synced (${userIds.length} users)`,
      metadata: { userCount: userIds.length, userIds, roleKey: actor.roleKey ?? null },
      actorType: actor.actorType ?? "user" },
    tx,
  ));
}
