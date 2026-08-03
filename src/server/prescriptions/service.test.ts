import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { auditEvents } from "@/server/audit/schema";
import { registerCustomer } from "@/server/customers/service";
import { prescriptions } from "./schema";
import { submitPrescription, reviewPrescription, listPendingPrescriptions } from "./service";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "pharmacy" }).returning();
  const customer = await registerCustomer(t.id, { name: "Patient", email: `p-${slug}@x.com`, password: "secret123" });
  const [pharmacist] = await db.insert(users).values({
    tenantId: t.id, name: "Dr Pharmacist", email: `rx-${slug}@x.com`, status: "active",
  }).returning();
  return { tenantId: t.id, customerId: customer.id, pharmacistId: pharmacist.id };
}

const audit = (userId: string) => ({
  actorUserId: userId,
  fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
});

describe("prescription review", () => {
  it("submits pending and audits rx.submitted", async () => {
    const { tenantId, customerId } = await seed("rxs-1");
    const rx = await submitPrescription(tenantId, customerId, "rx/1/script.jpg");
    expect(rx.status).toBe("pending");

    const audits = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "rx.submitted")));
    expect(audits).toHaveLength(1);
  });

  it("approves — recording WHO reviewed it and when, per the compliance trail", async () => {
    const { tenantId, customerId, pharmacistId } = await seed("rxs-2");
    const rx = await submitPrescription(tenantId, customerId, "rx/2/script.jpg");

    const approved = await reviewPrescription(tenantId, rx.id, { approved: true }, audit(pharmacistId));
    expect(approved.status).toBe("approved");
    expect(approved.reviewedByUserId).toBe(pharmacistId);
    expect(approved.reviewedAt).not.toBeNull();

    const audits = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "rx.approved")));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(pharmacistId);
  });

  it("rejects with a reason — a refusal without one is not reviewable after the fact", async () => {
    const { tenantId, customerId, pharmacistId } = await seed("rxs-3");
    const rx = await submitPrescription(tenantId, customerId, "rx/3/script.jpg");

    await expect(reviewPrescription(tenantId, rx.id, { approved: false }, audit(pharmacistId)))
      .rejects.toThrow(/reason/i);

    const rejected = await reviewPrescription(
      tenantId, rx.id, { approved: false, reason: "Script is illegible" }, audit(pharmacistId),
    );
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Script is illegible");
  });

  it("refuses to re-review an already-decided prescription", async () => {
    const { tenantId, customerId, pharmacistId } = await seed("rxs-4");
    const rx = await submitPrescription(tenantId, customerId, "rx/4/script.jpg");
    await reviewPrescription(tenantId, rx.id, { approved: true }, audit(pharmacistId));
    await expect(reviewPrescription(tenantId, rx.id, { approved: false, reason: "changed mind" }, audit(pharmacistId)))
      .rejects.toThrow(/already/i);
  });

  it("lists only this tenant's pending scripts", async () => {
    const a = await seed("rxs-5");
    const b = await seed("rxs-6");
    await submitPrescription(a.tenantId, a.customerId, "rx/a.jpg");
    const decided = await submitPrescription(a.tenantId, a.customerId, "rx/a2.jpg");
    await reviewPrescription(a.tenantId, decided.id, { approved: true }, audit(a.pharmacistId));
    await submitPrescription(b.tenantId, b.customerId, "rx/b.jpg");

    const pending = await listPendingPrescriptions(a.tenantId);
    expect(pending).toHaveLength(1);
    expect(pending[0].imagePath).toBe("rx/a.jpg");
  });

  it("keeps prescriptions invisible across tenants even by id", async () => {
    const a = await seed("rxs-7");
    const b = await seed("rxs-8");
    const rx = await submitPrescription(a.tenantId, a.customerId, "rx/private.jpg");
    // Tenant B naming A's prescription id must not be able to review it.
    await expect(reviewPrescription(b.tenantId, rx.id, { approved: true }, audit(b.pharmacistId)))
      .rejects.toThrow();
    const [stillPending] = await withTenant(a.tenantId, (tx) =>
      tx.select().from(prescriptions).where(eq(prescriptions.id, rx.id)));
    expect(stillPending.status).toBe("pending");
  });
});
