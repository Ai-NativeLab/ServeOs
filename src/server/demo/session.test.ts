import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles, sessions } from "@/server/auth/schema";
import { validateSession } from "@/server/auth/session";
import { VERTICAL_IDS } from "@/server/verticals";
import { startDemoSession, isVerticalId } from "./session";
import { demoSlug, isDemoSlug } from "./entry";

/** Minimal tenant + owner, enough for the demo login to resolve. */
async function seedTenantWithOwner(slug: string) {
  const [tenant] = await db
    .insert(tenants)
    .values({ slug, name: slug, country: "EG" })
    .returning();
  const [user] = await db
    .insert(users)
    .values({ tenantId: tenant.id, name: "Owner", email: `owner@${slug}.test`, passwordHash: "x" })
    .returning();
  const [role] = await db
    .insert(roles)
    .values({ tenantId: tenant.id, key: "owner", name: "Owner" })
    .returning();
  await db.insert(userRoles).values({ userId: user.id, roleId: role.id });
  return { tenant, user };
}

describe("demoSlug / isDemoSlug", () => {
  it("names every demo tenant with the demo- prefix the login guard checks", () => {
    for (const trade of VERTICAL_IDS) {
      expect(demoSlug(trade)).toBe(`demo-${trade}`);
      expect(isDemoSlug(demoSlug(trade))).toBe(true);
    }
  });

  it("does not treat the showcase or a real-looking tenant as a demo", () => {
    for (const slug of ["roma", "nobio", "acme", "demoish", "notdemo-restaurant"]) {
      expect(isDemoSlug(slug)).toBe(false);
    }
  });
});

describe("isVerticalId", () => {
  it("accepts every registered trade", () => {
    for (const id of VERTICAL_IDS) expect(isVerticalId(id)).toBe(true);
  });

  it("rejects anything else, so the slug is never built from raw input", () => {
    for (const bad of ["", "roma", "../roma", "restaurant; drop", "RESTAURANT"]) {
      expect(isVerticalId(bad)).toBe(false);
    }
  });
});

describe("startDemoSession", () => {
  it("mints a working session for a seeded demo tenant", async () => {
    const { tenant, user } = await seedTenantWithOwner(demoSlug("restaurant"));

    const result = await startDemoSession("restaurant");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = await validateSession(result.token);
    expect(session?.user.id).toBe(user.id);
    expect(session?.user.tenantId).toBe(tenant.id);
  });

  it("expires in hours, not the thirty days a real login gets", async () => {
    await seedTenantWithOwner(demoSlug("retail"));
    const result = await startDemoSession("retail");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const hours = (result.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThanOrEqual(2);
  });

  // The whole safety story of a credential-free endpoint.
  it("refuses a trade that is not registered, so no slug is built from input", async () => {
    await seedTenantWithOwner("roma");
    for (const bad of ["roma", "../roma", "", "restaurant2"]) {
      const result = await startDemoSession(bad);
      expect(result).toEqual({ ok: false, reason: "unknown_trade" });
    }
  });

  it("never signs anyone into a non-demo tenant that exists", async () => {
    // A real tenant is present; asking for a trade whose demo is NOT seeded
    // must not fall through to it.
    await seedTenantWithOwner("roma");
    const result = await startDemoSession("restaurant");
    expect(result).toEqual({ ok: false, reason: "no_tenant" });

    const all = await db.select().from(sessions);
    expect(all).toHaveLength(0);
  });

  it("mints nothing when the demo tenant has no owner", async () => {
    await db.insert(tenants).values({ slug: demoSlug("timber"), name: "t", country: "EG" });
    const result = await startDemoSession("timber");
    expect(result).toEqual({ ok: false, reason: "no_owner" });

    const all = await db.select().from(sessions);
    expect(all).toHaveLength(0);
  });

  it("only ever reaches the tenant whose slug matches the requested trade", async () => {
    await seedTenantWithOwner(demoSlug("restaurant"));
    await seedTenantWithOwner(demoSlug("pharmacy"));

    const result = await startDemoSession("pharmacy");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const session = await validateSession(result.token);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session!.user.tenantId!));
    expect(tenant.slug).toBe(demoSlug("pharmacy"));
  });
});
