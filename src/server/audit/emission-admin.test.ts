import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createStaff, setStaffRole } from "@/server/auth/staff";
import { updateTaxSettings } from "@/server/tenancy/settings";
import { createBranch } from "@/server/branches/service";
import { createBanner } from "@/server/banners/service";
import { registerTenant } from "@/server/onboarding/service";
import { auditEvents } from "./schema";
import { verifyChain } from "./verifier";
import type { AuditActorInput } from "./service";

const fp = () => ({ deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null });

async function eventsFor(tenantId: string, action: string) {
  return withTenant(tenantId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action))));
}

let n = 0;
async function seedTenantWithOwner() {
  const [t] = await db.insert(tenants).values({ slug: `audit-admin-${n++}`, name: "T", country: "EG", vertical: "restaurant" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  const [owner] = await db.insert(users).values({
    tenantId: t.id, name: "Owner", email: `owner-${n}@x.com`, status: "active", passwordHash: await hashPassword("pw123456"),
  }).returning();
  const audit: AuditActorInput = { actorUserId: owner.id, actorType: "user", roleKey: "owner", fingerprint: fp() };
  return { tenantId: t.id, ownerId: owner.id, audit };
}

describe("audit emission — admin surfaces", () => {
  it("setStaffRole emits staff.role_changed with before/after", async () => {
    const { tenantId, audit } = await seedTenantWithOwner();
    const staff = await createStaff(tenantId, { name: "S", email: `s-${n}@x.com`, password: "pw123456", roleKey: "staff" }, audit);
    await setStaffRole(tenantId, staff.id, "manager", audit);
    const [row] = await eventsFor(tenantId, "staff.role_changed");
    expect(row.metadata).toMatchObject({ before: "staff", after: "manager" });
  });

  it("createStaff emits staff.invited", async () => {
    const { tenantId, audit } = await seedTenantWithOwner();
    await createStaff(tenantId, { name: "S", email: `s2-${n}@x.com`, password: "pw123456", roleKey: "staff" }, audit);
    expect(await eventsFor(tenantId, "staff.invited")).toHaveLength(1);
  });

  it("updateTaxSettings emits settings.vat_changed with before/after", async () => {
    const { tenantId, audit } = await seedTenantWithOwner();
    await updateTaxSettings(tenantId, { vatRate: 20 }, audit);
    const [row] = await eventsFor(tenantId, "settings.vat_changed");
    expect(row.metadata.before).not.toBe(row.metadata.after);
    expect(row.metadata).toMatchObject({ after: 20 });
  });

  it("createBranch emits branch.created", async () => {
    const { tenantId, audit } = await seedTenantWithOwner();
    await createBranch(tenantId, { name: "Main" }, audit);
    expect(await eventsFor(tenantId, "branch.created")).toHaveLength(1);
  });

  it("createBanner emits banner.created", async () => {
    const { tenantId, audit } = await seedTenantWithOwner();
    await createBanner(tenantId, { imageUrl: "https://x/y.png" }, audit);
    expect(await eventsFor(tenantId, "banner.created")).toHaveLength(1);
  });

  it("startTrial emits subscription.trial_started", async () => {
    const { tenantId } = await seedTenantWithOwner();
    expect((await eventsFor(tenantId, "subscription.trial_started")).length).toBeGreaterThanOrEqual(1);
  });

  it("registerTenant emits tenant.registered as the chain genesis (seq 1)", async () => {
    await seedDefaultPlans();
    const res = await registerTenant({
      restaurantName: "R", slug: `reg-${n++}`, country: "EG", ownerName: "O",
      email: `reg-${n}@x.com`, password: "pw123456", vertical: "restaurant",
    });
    const [row] = await eventsFor(res.tenantId, "tenant.registered");
    expect(row.seq).toBe(1);
    expect(row.actorType).toBe("user");
    expect((await verifyChain(res.tenantId)).ok).toBe(true);
  });
});
