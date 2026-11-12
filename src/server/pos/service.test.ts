import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { createBranch } from "@/server/branches/service";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { createPairingCode, redeemPairingCode, resolveDevice, listDevices, revokeDevice, loginForPos } from "./service";
import { hashPassword } from "@/server/auth/password";

let n = 0;
async function seedTenantBranchUser() {
  const slug = `pos-${n++}`;
  const [t] = await db.insert(tenants).values({ slug, name: "Test", country: "EG" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "basic");
  const branch = await createBranch(t.id, { name: "Front counter" });
  const [user] = await db.insert(users).values({ tenantId: t.id, name: "Owner" }).returning();
  return { tenantId: t.id, branchId: branch.id, userId: user.id };
}

describe("loginForPos", () => {
  // Emails are matched ignoring case and surrounding spaces (#204): an owner
  // who signed up as ahmed@roma.com and types "Ahmed@Roma.com " at the till
  // is the same person.
  it("logs in when the email is typed with different casing and spaces", async () => {
    const { tenantId } = await seedTenantBranchUser();
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    const [u] = await db.insert(users).values({
      tenantId, name: "Ahmed", email: "ahmed@roma.com", passwordHash: await hashPassword("pw123456"), status: "active",
    }).returning();
    const res = await loginForPos(t.slug, " Ahmed@Roma.COM ", "pw123456", null);
    expect(res.status).toBe("paired");
    if (res.status === "paired") expect((await resolveDevice(res.deviceToken))?.createdByUserId).toBe(u.id);
  });
});

describe("pos pairing", () => {
  it("redeems a fresh code into a working device token", async () => {
    const { tenantId, branchId, userId } = await seedTenantBranchUser();
    const { code } = await createPairingCode(tenantId, branchId, "Front counter", userId);
    const res = await redeemPairingCode(code);
    expect(res.tenantId).toBe(tenantId);
    expect(res.branchId).toBe(branchId);
    expect(res.branchName).toBe("Front counter");
    const dev = await resolveDevice(res.deviceToken);
    expect(dev?.tenantId).toBe(tenantId);
    expect(dev?.branchId).toBe(branchId);
  });

  it("rejects a reused code", async () => {
    const { tenantId, branchId, userId } = await seedTenantBranchUser();
    const { code } = await createPairingCode(tenantId, branchId, "x", userId);
    await redeemPairingCode(code);
    await expect(redeemPairingCode(code)).rejects.toThrow();
  });

  it("rejects an unknown code", async () => {
    await expect(redeemPairingCode("ZZZZZZZZ")).rejects.toThrow();
  });

  it("revoked device no longer resolves", async () => {
    const { tenantId, branchId, userId } = await seedTenantBranchUser();
    const { code } = await createPairingCode(tenantId, branchId, "x", userId);
    const { deviceToken } = await redeemPairingCode(code);
    const [dev] = await listDevices(tenantId);
    await revokeDevice(tenantId, dev.id);
    expect(await resolveDevice(deviceToken)).toBeNull();
  });
});
