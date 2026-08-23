import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { posDevices } from "./schema";
import { requirePosDevice } from "./require-device";
import { PosAuthError, PosTenantBlockedError } from "./errors";

/**
 * #164: a suspended/rejected/onboarding tenant must not be able to run its
 * tills either. The device resolver is the single choke point every POS v1
 * route authenticates through, so the gate lives here.
 */

async function seedTenantWithDevice(slug: string, status: "active" | "suspended" | "onboarding" | "rejected" | "trial") {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", status }).returning();
  const [branch] = await withTenant(t.id, (tx) => tx.insert(branches).values({ tenantId: t.id, name: "Main" }).returning());
  const [user] = await db.insert(users).values({ tenantId: t.id, name: "Owner", email: `${slug}@x.com`, status: "active" }).returning();
  const [device] = await db.insert(posDevices).values({
    tenantId: t.id, branchId: branch.id, label: "Till 1",
    token: `tok-${slug}`, createdByUserId: user.id,
  }).returning();
  return { tenantId: t.id, token: device!.token };
}

const reqWith = (token: string) =>
  new Request("http://localhost/api/pos/v1/ping", { headers: { authorization: `Bearer ${token}` } });

describe("POS tenant-status gate (#164)", () => {
  it("blocks a suspended tenant's device with a refusal that says why", async () => {
    const { token } = await seedTenantWithDevice("posg-susp", "suspended");
    await expect(requirePosDevice(reqWith(token))).rejects.toBeInstanceOf(PosTenantBlockedError);
    await expect(requirePosDevice(reqWith(token))).rejects.toThrow(/suspended/i);
  });

  it("blocks rejected and onboarding tenants too — the till is not a pre-approval surface", async () => {
    for (const status of ["rejected", "onboarding"] as const) {
      const { token } = await seedTenantWithDevice(`posg-${status}`, status);
      await expect(requirePosDevice(reqWith(token))).rejects.toBeInstanceOf(PosTenantBlockedError);
    }
  });

  it("still serves active and trial tenants", async () => {
    for (const status of ["active", "trial"] as const) {
      const { token } = await seedTenantWithDevice(`posg-ok-${status}`, status);
      await expect(requirePosDevice(reqWith(token))).resolves.toBeDefined();
    }
  });

  it("stays a PosAuthError subclass so every route's existing catch refuses without changes", async () => {
    const { token } = await seedTenantWithDevice("posg-sub", "suspended");
    await expect(requirePosDevice(reqWith(token))).rejects.toBeInstanceOf(PosAuthError);
  });
});
