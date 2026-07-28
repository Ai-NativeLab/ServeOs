import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/server/auth/schema";
import { tenants } from "@/server/tenancy/schema";
import { onboardingApplications } from "@/server/onboarding/schema";
import { subscriptions } from "@/server/subscription/schema";
import { auditLogs } from "./audit.schema";
import { seedDefaultPlans } from "@/server/subscription";
import { registerTenant } from "@/server/onboarding";
import { listPendingApplications, approveTenant, rejectTenant, suspendTenant } from "./service";
import {
  listTenants, getTenantDetail, listAuditLogs, activateTenant,
  cancelSubscription, forceSubscriptionActive, markSubscriptionPaid,
  ensurePlatformSuperAdmin,
} from "./service";
import { roles, userRoles } from "@/server/auth/schema";
import { loadUserRoleKeys } from "@/server/auth/current-user";

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

  it("pending applications include the tenant vertical", async () => {
    await seedDefaultPlans();
    const { tenantId } = await registerTenant({ restaurantName: "Wood & Co", slug: "adm-timber", country: "EG", ownerName: "O", email: "o@adm-timber.com", password: "x", vertical: "timber" });
    const pending = await listPendingApplications();
    const row = pending.find((p) => p.tenantId === tenantId);
    expect(row?.vertical).toBe("timber");
  });
});

describe("platform tenant + billing service", () => {
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

describe("ensurePlatformSuperAdmin", () => {
  it("grants super_admin to an existing platform user that is missing the role", async () => {
    // The repair case: a half-provisioned admin. The user row exists, so any
    // create-if-missing seed skips it forever and it can never sign in.
    const [u] = await db
      .insert(users)
      .values({ tenantId: null, name: "Platform Admin", email: "a@serveos.com", passwordHash: "x" })
      .returning();
    expect(await loadUserRoleKeys(u.id)).toEqual([]);

    const res = await ensurePlatformSuperAdmin("a@serveos.com");

    expect(res).toMatchObject({ userId: u.id, created: false, roleGranted: true });
    expect(await loadUserRoleKeys(u.id)).toEqual(["super_admin"]);
  });

  it("is idempotent — a second run grants nothing and leaves one role link", async () => {
    await db
      .insert(users)
      .values({ tenantId: null, name: "Platform Admin", email: "b@serveos.com", passwordHash: "x" })
      .returning();

    await ensurePlatformSuperAdmin("b@serveos.com");
    const second = await ensurePlatformSuperAdmin("b@serveos.com");

    expect(second.roleGranted).toBe(false);
    expect(await db.select().from(userRoles)).toHaveLength(1);
    expect(await db.select().from(roles)).toHaveLength(1);
  });

  it("reuses an existing platform super_admin role rather than duplicating it", async () => {
    const [r] = await db
      .insert(roles)
      .values({ tenantId: null, key: "super_admin", name: "Super Admin" })
      .returning();
    await db
      .insert(users)
      .values({ tenantId: null, name: "Platform Admin", email: "c@serveos.com", passwordHash: "x" })
      .returning();

    await ensurePlatformSuperAdmin("c@serveos.com");

    const all = await db.select().from(roles);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(r.id);
  });

  it("throws a clear error when the platform user does not exist", async () => {
    await expect(ensurePlatformSuperAdmin("nobody@serveos.com")).rejects.toThrow(/no platform user/i);
  });

  it("ignores tenant-scoped users with the same email", async () => {
    const [t] = await db.insert(tenants).values({ name: "R", slug: "r-scoped", country: "EG", vertical: "restaurant" }).returning();
    await db.insert(users).values({ tenantId: t.id, name: "Owner", email: "dup@serveos.com", passwordHash: "x" });

    await expect(ensurePlatformSuperAdmin("dup@serveos.com")).rejects.toThrow(/no platform user/i);
  });
});
