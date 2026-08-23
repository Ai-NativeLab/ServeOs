import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { withTenant } from "@/db/with-tenant";
import { auditEvents } from "@/server/audit/schema";
import { branches } from "@/server/branches/schema";
import { eq, and } from "drizzle-orm";
import { createPairingCode, redeemPairingCode } from "./service";
import { signInCashier } from "./cashier";
import { listPosUsers } from "./auth-sync";
import { GET } from "@/app/api/pos/v1/sync/auth/route";

let n = 0;
const roleCache = new Map<string, string>(); // `${tenantId}:${roleKey}` -> roleId, one role row per tenant+key

async function seedTenant() {
  const i = n++;
  const [t] = await db.insert(tenants).values({
    slug: `auth-sync-${i}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  return t.id;
}

async function seedUser(
  tenantId: string,
  roleKey: "owner" | "manager" | "staff" | "super_admin",
  opts: { status?: string; email?: string; withRole?: boolean } = {},
) {
  const i = n++;
  const [u] = await db.insert(users).values({
    tenantId, name: `User ${i}`, email: opts.email ?? `u${i}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: opts.status ?? "active",
  }).returning();
  if (opts.withRole !== false) {
    const cacheKey = `${tenantId}:${roleKey}`;
    let roleId = roleCache.get(cacheKey);
    if (!roleId) {
      const [r] = await db.insert(roles).values({ tenantId, key: roleKey, name: roleKey }).returning();
      roleId = r.id;
      roleCache.set(cacheKey, roleId);
    }
    await db.insert(userRoles).values({ userId: u.id, roleId });
  }
  return u;
}

describe("listPosUsers", () => {
  it("returns POS-capable users with scrypt hashes, permissions including reconciliation:manage for a manager", async () => {
    const tenantId = await seedTenant();
    const staff = await seedUser(tenantId, "staff");
    const manager = await seedUser(tenantId, "manager");

    const roster = await listPosUsers(tenantId);
    const byId = new Map(roster.map((u) => [u.userId, u]));

    const staffRow = byId.get(staff.id);
    expect(staffRow).toBeDefined();
    expect(staffRow?.name).toBe(staff.name);
    expect(staffRow?.email).toBe(staff.email);
    expect(staffRow?.passwordHash).toBe(staff.passwordHash); // exact scrypt "salt:hash" string
    expect(staffRow?.permissions).toContain("pos:sell");
    expect(staffRow?.permissions).not.toContain("reconciliation:manage");

    const managerRow = byId.get(manager.id);
    expect(managerRow?.permissions).toEqual(expect.arrayContaining(["pos:sell", "reconciliation:manage"]));
  });

  it("excludes inactive users", async () => {
    const tenantId = await seedTenant();
    const inactive = await seedUser(tenantId, "staff", { status: "inactive" });
    const active = await seedUser(tenantId, "staff");

    const roster = await listPosUsers(tenantId);
    expect(roster.find((u) => u.userId === inactive.id)).toBeUndefined();
    expect(roster.find((u) => u.userId === active.id)).toBeDefined();
  });

  it("excludes other tenants' users", async () => {
    const tenantA = await seedTenant();
    const tenantB = await seedTenant();
    const userA = await seedUser(tenantA, "owner");
    const userB = await seedUser(tenantB, "owner");

    const roster = await listPosUsers(tenantA);
    expect(roster.find((u) => u.userId === userA.id)).toBeDefined();
    expect(roster.find((u) => u.userId === userB.id)).toBeUndefined();
  });

  it("excludes a user whose roles grant no pos:* or reconciliation:manage permission", async () => {
    const tenantId = await seedTenant();
    const noRole = await seedUser(tenantId, "staff", { withRole: false }); // no role at all -> empty permission union
    const roster = await listPosUsers(tenantId);
    expect(roster.find((u) => u.userId === noRole.id)).toBeUndefined();
  });
});

describe("GET /api/pos/v1/sync/auth", () => {
  async function seedDeviceAndCashier(roleKey: "owner" | "staff" | "manager") {
    const tenantId = await seedTenant();
    const user = await seedUser(tenantId, roleKey);
    const [branch] = await withTenant(tenantId, (tx) =>
      tx.insert(branches).values({ tenantId, name: "Main" }).returning(),
    );
    const { code } = await createPairingCode(tenantId, branch.id, "counter", user.id);
    const { deviceToken } = await redeemPairingCode(code);
    const { cashierToken } = await signInCashier(tenantId, user.email!, "pw123456");
    return { tenantId, userId: user.id, deviceToken, cashierToken };
  }

  it("requires cashier auth: rejects a request with no cashier token", async () => {
    const { deviceToken } = await seedDeviceAndCashier("owner");
    const req = new NextRequest("http://x/api/pos/v1/sync/auth", {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("requires cashier auth: rejects a request with no device token at all", async () => {
    const req = new NextRequest("http://x/api/pos/v1/sync/auth");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("responds with the roster and syncedAt for a valid cashier, and records an audit event without ever including hashes in it", async () => {
    const { tenantId, userId, deviceToken, cashierToken } = await seedDeviceAndCashier("owner");
    const req = new NextRequest("http://x/api/pos/v1/sync/auth", {
      headers: { Authorization: `Bearer ${deviceToken}`, "X-POS-Cashier": cashierToken },
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users.length).toBeGreaterThan(0);
    expect(typeof body.syncedAt).toBe("string");
    const self = body.users.find((u: { userId: string }) => u.userId === userId);
    expect(self).toBeDefined();
    expect(self.passwordHash).toBeTruthy();
    expect(Object.keys(self).sort()).toEqual(["email", "name", "passwordHash", "permissions", "userId"]);

    const rows = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, "auth.roster_synced"))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(userId);
    // The audit row must never carry a password hash anywhere in its metadata.
    expect(JSON.stringify(rows[0].metadata)).not.toContain(self.passwordHash);
  });
});
