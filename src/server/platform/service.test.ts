import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { subscriptions } from "@/server/subscription/schema";
import { auditLogs } from "./audit.schema";
import { seedDefaultPlans, getPlanForTenant } from "@/server/subscription";
import { registerTenant } from "@/server/onboarding";
import { branches } from "@/server/branches/schema";
import { products } from "@/server/catalog/schema";
import { orders } from "@/server/ordering/schema";
import { listPendingApplications, approveTenant, rejectTenant, suspendTenant } from "./service";
import {
  listTenants, getTenantDetail, listAuditLogs, activateTenant,
  cancelSubscription, forceSubscriptionActive, markSubscriptionPaid,
} from "./service";

async function admin() {
  const [a] = await db.insert(users).values({ tenantId: null, name: "Root", email: "root@serveos.com" }).returning();
  return a;
}

describe("platform approval", () => {
  it("approves a tenant, activates it, marks the application, and writes an audit log", async () => {
    await seedDefaultPlans();
    const a = await admin();
    const { tenantId } = await registerTenant({ restaurantName: "R", slug: "rest1", country: "EG", ownerName: "O", email: "o@r.com", password: "x", vertical: "restaurant" });

    const pending = await listPendingApplications();
    expect(pending).toHaveLength(1);
    expect(pending[0].tenantId).toBe(tenantId);

    await approveTenant(tenantId, a.id);

    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t.status).toBe("active");
    const [app] = await db.select().from(onboardingApplications).where(eq(onboardingApplications.tenantId, tenantId));
    expect(app.status).toBe("approved");
    expect(app.reviewedBy).toBe(a.id);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    expect(logs.map((l) => l.action)).toContain("tenant.approved");
  });

  it("rejects a tenant with notes", async () => {
    await seedDefaultPlans();
    const a = await admin();
    const { tenantId } = await registerTenant({ restaurantName: "R", slug: "rest2", country: "EG", ownerName: "O", email: "o2@r.com", password: "x", vertical: "restaurant" });
    await rejectTenant(tenantId, a.id, "Incomplete details");
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t.status).toBe("rejected");
    const [app] = await db.select().from(onboardingApplications).where(eq(onboardingApplications.tenantId, tenantId));
    expect(app.status).toBe("rejected");
    expect(app.reviewNotes).toBe("Incomplete details");
  });

  it("suspends a tenant and audits it", async () => {
    await seedDefaultPlans();
    const a = await admin();
    const { tenantId } = await registerTenant({ restaurantName: "R", slug: "rest3", country: "EG", ownerName: "O", email: "o3@r.com", password: "x", vertical: "restaurant" });
    await suspendTenant(tenantId, a.id);
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t.status).toBe("suspended");
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, tenantId));
    expect(logs.map((l) => l.action)).toContain("tenant.suspended");
  });

  it("throws when approving a non-existent tenant and writes no audit log", async () => {
    const a = await admin();
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(approveTenant(fakeId, a.id)).rejects.toThrow(/not found/i);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, fakeId));
    expect(logs).toHaveLength(0);
  });
});

describe("platform tenant + billing service", () => {
  beforeAll(async () => { await seedDefaultPlans(); });

  it("lists, details, audits, and admin-bills a tenant", async () => {
    await seedDefaultPlans();
    const adminUser = await admin();
    const { tenantId } = await registerTenant({ restaurantName: "Admin Co", slug: "admin-co", country: "EG", ownerName: "A", email: "a@admin.com", password: "x", vertical: "restaurant" });

    const listed = await listTenants({ search: "admin-co" });
    expect(listed.find((t) => t.id === tenantId)).toBeTruthy();

    const detail = await getTenantDetail(tenantId);
    expect(detail?.tenant.slug).toBe("admin-co");
    expect(detail?.plan?.key).toBe("basic");
    expect(detail?.branchCount).toBe(0);

    const suspended = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    // suspend via existing fn then activate via new fn
    await activateTenant(tenantId, adminUser.id);
    const after = await getTenantDetail(tenantId);
    expect(after?.tenant.status).toBe("active");

    await cancelSubscription(tenantId, adminUser.id);
    let sub = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    expect(sub[0].status).toBe("canceled");

    await forceSubscriptionActive(tenantId, adminUser.id);
    sub = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    expect(sub[0].status).toBe("active");

    await markSubscriptionPaid(tenantId, adminUser.id);
    sub = await db.select().from(subscriptions).where(eq(subscriptions.tenantId, tenantId));
    expect(sub[0].status).toBe("active");

    const logs = await listAuditLogs({ tenantId });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].tenantName).toBe("Admin Co");
  });

  it("returns null for unknown tenant detail", async () => {
    expect(await getTenantDetail("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
