import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { onboardingApplications } from "./schema";
import { seedDefaultPlans, getActiveSubscription } from "@/server/subscription";
import { registerTenant } from "./service";
import { type VerticalId } from "@/server/tenancy/verticals";

describe("registerTenant", () => {
  it("creates tenant, owner, owner role, trial subscription, and a pending application", async () => {
    await seedDefaultPlans();
    const result = await registerTenant({
      restaurantName: "Pizza Roma",
      slug: "roma",
      country: "EG",
      ownerName: "Sam",
      email: "sam@roma.com",
      password: "s3cret!",
      vertical: "restaurant",
    });

    const [t] = await db.select().from(tenants).where(eq(tenants.id, result.tenantId));
    expect(t.status).toBe("trial");

    const owner = await db.select().from(users).where(eq(users.tenantId, t.id));
    expect(owner).toHaveLength(1);
    expect(owner[0].passwordHash).toBeTruthy();
    expect(owner[0].passwordHash).not.toBe("s3cret!"); // hashed, not plaintext

    const ownerRoles = await db
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, owner[0].id));
    expect(ownerRoles.map((r) => r.key)).toContain("owner");

    expect((await getActiveSubscription(t.id))?.status).toBe("trialing");

    const apps = await db.select().from(onboardingApplications).where(eq(onboardingApplications.tenantId, t.id));
    expect(apps[0].status).toBe("pending");
  });

  it("rejects a duplicate slug", async () => {
    await seedDefaultPlans();
    await registerTenant({ restaurantName: "A", slug: "dup", country: "EG", ownerName: "A", email: "a@a.com", password: "x", vertical: "restaurant" });
    await expect(
      registerTenant({ restaurantName: "B", slug: "dup", country: "EG", ownerName: "B", email: "b@b.com", password: "x", vertical: "restaurant" }),
    ).rejects.toThrow();
  });

  it("rejects an invalid slug", async () => {
    await seedDefaultPlans();
    await expect(
      registerTenant({ restaurantName: "X", slug: "A_B!", country: "EG", ownerName: "X", email: "x@x.com", password: "x", vertical: "restaurant" }),
    ).rejects.toThrow(/slug/i);
  });

  it("rolls back fully when registration fails partway (no orphan tenant)", async () => {
    await seedDefaultPlans();
    await registerTenant({ restaurantName: "First", slug: "taken", country: "EG", ownerName: "F", email: "f@f.com", password: "x", vertical: "restaurant" });
    const before = await db.select().from(tenants);
    await expect(
      registerTenant({ restaurantName: "Second", slug: "taken", country: "EG", ownerName: "S", email: "s@s.com", password: "x", vertical: "restaurant" }),
    ).rejects.toThrow();
    const after = await db.select().from(tenants);
    expect(after.length).toBe(before.length); // failed attempt left no partial tenant
  });

  it("persists the chosen vertical", async () => {
    await seedDefaultPlans();
    const { tenantId } = await registerTenant({
      restaurantName: "Wood Co", slug: "woodco", country: "EG",
      ownerName: "W", email: "w@w.com", password: "x", vertical: "timber",
    });
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t.vertical).toBe("timber");
  });

  it("rejects an invalid vertical", async () => {
    await seedDefaultPlans();
    await expect(
      registerTenant({
        restaurantName: "X", slug: "xv", country: "EG",
        ownerName: "X", email: "x@x.com", password: "x", vertical: "spaceship" as VerticalId,
      }),
    ).rejects.toThrow(/vertical/i);
  });
});
