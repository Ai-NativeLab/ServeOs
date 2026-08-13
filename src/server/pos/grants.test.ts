import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { issueGrant, consumeGrant } from "./grants";
import { posGrants } from "./schema";
import { PosForbiddenError } from "./errors";

let n = 0;

/** A tenant and one user (`authorizedByUserId` is FK'd to a real user row). */
async function seedTenantAndManager() {
  const [t] = await db.insert(tenants).values({
    slug: `pos-grants-${n++}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  const [u] = await db.insert(users).values({
    tenantId: t.id, name: "Man Ager", email: `mgr${n}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  return { tenantId: t.id, managerId: u.id };
}

describe("grants", () => {
  it("consumes a valid grant once and returns the authorizer", async () => {
    const { tenantId, managerId } = await seedTenantAndManager();
    const token = await issueGrant(tenantId, "pos:discount", managerId);
    expect(await consumeGrant(tenantId, token, "pos:discount")).toBe(managerId);
  });

  it("a grant is single-use across 'instances' (DB-backed)", async () => {
    const { tenantId, managerId: ownerId } = await seedTenantAndManager();
    const token = await issueGrant(tenantId, "pos:discount", ownerId);
    expect(await consumeGrant(tenantId, token, "pos:discount")).toBe(ownerId);
    await expect(consumeGrant(tenantId, token, "pos:discount")).rejects.toThrow(PosForbiddenError);
  });

  // The reason the table exists: the old in-memory Map could hand the same
  // grant to two concurrent handlers. The DELETE ... RETURNING makes Postgres
  // row locking the arbiter, so exactly one caller can ever win the race.
  it("two concurrent consumes of one grant: exactly one wins", async () => {
    const { tenantId, managerId } = await seedTenantAndManager();
    const token = await issueGrant(tenantId, "pos:discount", managerId);

    const settled = await Promise.allSettled([
      consumeGrant(tenantId, token, "pos:discount"),
      consumeGrant(tenantId, token, "pos:discount"),
    ]);

    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("refuses to reuse a grant", async () => {
    const { tenantId, managerId } = await seedTenantAndManager();
    const token = await issueGrant(tenantId, "pos:discount", managerId);
    await consumeGrant(tenantId, token, "pos:discount");
    await expect(consumeGrant(tenantId, token, "pos:discount")).rejects.toThrow(PosForbiddenError);
  });

  it("refuses a grant issued for a different permission", async () => {
    const { tenantId, managerId } = await seedTenantAndManager();
    const token = await issueGrant(tenantId, "pos:void", managerId);
    await expect(consumeGrant(tenantId, token, "pos:discount")).rejects.toThrow(PosForbiddenError);
  });

  it("refuses a grant issued for a different tenant", async () => {
    const { tenantId, managerId } = await seedTenantAndManager();
    const { tenantId: otherTenantId } = await seedTenantAndManager();
    const token = await issueGrant(tenantId, "pos:discount", managerId);
    await expect(consumeGrant(otherTenantId, token, "pos:discount")).rejects.toThrow(PosForbiddenError);
  });

  it("refuses an expired grant", async () => {
    const { tenantId, managerId } = await seedTenantAndManager();
    const token = await issueGrant(tenantId, "pos:discount", managerId);
    await db.update(posGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(posGrants.tenantId, tenantId));
    await expect(consumeGrant(tenantId, token, "pos:discount")).rejects.toThrow(PosForbiddenError);
  });

  it("refuses an unknown token", async () => {
    const { tenantId } = await seedTenantAndManager();
    await expect(consumeGrant(tenantId, "nope", "pos:discount")).rejects.toThrow(PosForbiddenError);
  });
});
