import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { auditLogs } from "./audit.schema";

export async function listPendingApplications() {
  return db
    .select({
      applicationId: onboardingApplications.id,
      tenantId: tenants.id,
      tenantName: tenants.name,
      slug: tenants.slug,
      submittedAt: onboardingApplications.submittedAt,
    })
    .from(onboardingApplications)
    .innerJoin(tenants, eq(tenants.id, onboardingApplications.tenantId))
    .where(eq(onboardingApplications.status, "pending"));
}

export async function approveTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(tenants).set({ status: "active" }).where(eq(tenants.id, tenantId));
    await tx
      .update(onboardingApplications)
      .set({ status: "approved", reviewedBy: adminUserId })
      .where(eq(onboardingApplications.tenantId, tenantId));
    await tx.insert(auditLogs).values({
      tenantId,
      actorUserId: adminUserId,
      action: "tenant.approved",
      target: tenantId,
    });
  });
}

export async function rejectTenant(tenantId: string, adminUserId: string, notes: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(tenants).set({ status: "rejected" }).where(eq(tenants.id, tenantId));
    await tx
      .update(onboardingApplications)
      .set({ status: "rejected", reviewedBy: adminUserId, reviewNotes: notes })
      .where(eq(onboardingApplications.tenantId, tenantId));
    await tx.insert(auditLogs).values({
      tenantId,
      actorUserId: adminUserId,
      action: "tenant.rejected",
      target: tenantId,
      metadata: { notes },
    });
  });
}

export async function suspendTenant(tenantId: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, tenantId));
    await tx.insert(auditLogs).values({ tenantId, actorUserId: adminUserId, action: "tenant.suspended", target: tenantId });
  });
}
