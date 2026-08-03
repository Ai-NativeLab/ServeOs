import { and, eq, desc } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { orders } from "@/server/ordering/schema";
import { prescriptions, type Prescription } from "./schema";

const auditCtx = (tenantId: string, audit?: AuditActorInput) => ({
  tenantId,
  actorUserId: audit?.actorUserId ?? null,
  fingerprint: audit?.fingerprint ?? emptyFingerprint(),
});

/** A customer's script lands here pending review. imagePath is a private
 *  storage path (decision R4) — never a public URL. */
export async function submitPrescription(
  tenantId: string,
  customerId: string,
  imagePath: string,
): Promise<Prescription> {
  return withTenant(tenantId, async (tx) => {
    const [rx] = await tx.insert(prescriptions)
      .values({ tenantId, customerId, imagePath })
      .returning();

    await recordAuditEvent(auditCtx(tenantId), {
      action: "rx.submitted",
      entityType: "prescription",
      entityId: rx.id,
      summary: "Prescription submitted for review",
      metadata: { customerId },
      actorType: "customer",
    }, tx);

    return rx;
  });
}

/**
 * The clinical decision. Records WHO reviewed it and when — that pairing is
 * the compliance trail's whole point — and moves the linked order's review
 * axis in the SAME transaction, so an approved script and a releasable order
 * can never disagree.
 *
 * A rejection requires a reason: a refusal nobody can explain afterwards is
 * not reviewable, and the customer needs to know what to fix.
 */
export async function reviewPrescription(
  tenantId: string,
  prescriptionId: string,
  input: { approved: boolean; reason?: string },
  audit: AuditActorInput,
): Promise<Prescription> {
  if (!input.approved && !input.reason?.trim()) {
    throw new Error("A rejection reason is required");
  }

  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx.select().from(prescriptions)
      .where(and(eq(prescriptions.id, prescriptionId), eq(prescriptions.tenantId, tenantId)))
      .limit(1);
    if (!existing) throw new Error("Prescription not found");
    if (existing.status !== "pending") {
      throw new Error(`This prescription was already ${existing.status}`);
    }

    const [updated] = await tx.update(prescriptions)
      .set({
        status: input.approved ? "approved" : "rejected",
        reviewedByUserId: audit.actorUserId ?? null,
        reviewedAt: new Date(),
        rejectionReason: input.approved ? null : (input.reason ?? null),
      })
      .where(and(eq(prescriptions.id, prescriptionId), eq(prescriptions.status, "pending")))
      .returning();
    if (!updated) throw new Error("Prescription was reviewed by someone else");

    // The order's review axis moves with the decision — one transaction, so an
    // approved script and a still-blocked order cannot drift apart.
    if (updated.orderId) {
      await tx.update(orders)
        .set({ rxReviewStatus: input.approved ? "approved" : "rejected" })
        .where(eq(orders.id, updated.orderId));
    }

    await recordAuditEvent(auditCtx(tenantId, audit), {
      action: input.approved ? "rx.approved" : "rx.rejected",
      entityType: "prescription",
      entityId: prescriptionId,
      summary: input.approved
        ? "Prescription approved by pharmacist"
        : `Prescription rejected: ${input.reason}`,
      metadata: { orderId: updated.orderId, reason: input.reason ?? null },
      actorType: "user",
    }, tx);

    return updated;
  });
}

export async function listPendingPrescriptions(tenantId: string): Promise<Prescription[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(prescriptions)
      .where(and(eq(prescriptions.tenantId, tenantId), eq(prescriptions.status, "pending")))
      .orderBy(desc(prescriptions.createdAt)));
}

/** The customer's own scripts — powering "my prescriptions" on /account. */
export async function listCustomerPrescriptions(tenantId: string, customerId: string): Promise<Prescription[]> {
  return withTenant(tenantId, (tx) =>
    tx.select().from(prescriptions)
      .where(and(eq(prescriptions.tenantId, tenantId), eq(prescriptions.customerId, customerId)))
      .orderBy(desc(prescriptions.createdAt)));
}
