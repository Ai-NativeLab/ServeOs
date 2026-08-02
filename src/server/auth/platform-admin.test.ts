import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users, roles, userRoles } from "./schema";
import { tenants } from "@/server/tenancy/schema";
import { loadUserRoleKeys } from "./current-user";
import { ensurePlatformSuperAdmin } from "./platform-admin";

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

    expect(res).toMatchObject({ userId: u.id, roleGranted: true });
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
