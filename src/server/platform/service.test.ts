import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { auditLogs } from "./audit.schema";
import { seedDefaultPlans } from "@/server/subscription";
import { registerRestaurant } from "@/server/onboarding";
import { listPendingApplications, approveTenant, rejectTenant, suspendTenant } from "./service";

async function admin() {
  const [a] = await db.insert(users).values({ tenantId: null, name: "Root", email: "root@serveos.com" }).returning();
  return a;
}

describe("platform approval", () => {
  it("approves a tenant, activates it, marks the application, and writes an audit log", async () => {
    await seedDefaultPlans();
    const a = await admin();
    const { tenantId } = await registerRestaurant({ restaurantName: "R", slug: "rest1", country: "EG", ownerName: "O", email: "o@r.com", password: "x" });

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
    const { tenantId } = await registerRestaurant({ restaurantName: "R", slug: "rest2", country: "EG", ownerName: "O", email: "o2@r.com", password: "x" });
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
    const { tenantId } = await registerRestaurant({ restaurantName: "R", slug: "rest3", country: "EG", ownerName: "O", email: "o3@r.com", password: "x" });
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
