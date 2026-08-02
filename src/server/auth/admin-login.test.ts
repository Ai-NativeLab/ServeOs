import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users, roles, userRoles } from "./schema";
import { tenants } from "@/server/tenancy/schema";
import { hashPassword } from "./password";
import { authenticatePlatformAdmin } from "./admin-login";

async function platformUser(email: string, password = "pw1234") {
  const [u] = await db
    .insert(users)
    .values({ tenantId: null, name: "Platform Admin", email, passwordHash: await hashPassword(password) })
    .returning();
  return u;
}

async function grantSuperAdmin(userId: string) {
  const [r] = await db.insert(roles).values({ tenantId: null, key: "super_admin", name: "Super Admin" }).returning();
  await db.insert(userRoles).values({ userId, roleId: r.id });
}

describe("authenticatePlatformAdmin", () => {
  it("accepts a platform user who holds super_admin", async () => {
    const u = await platformUser("ok@serveos.com");
    await grantSuperAdmin(u.id);

    const res = await authenticatePlatformAdmin("ok@serveos.com", "pw1234");

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user.id).toBe(u.id);
  });

  it("rejects a platform user with valid credentials but no super_admin role", async () => {
    // The production failure: authentication succeeds, authorization does not.
    // The session must never be created, or the admin is handed a cookie that
    // every /admin page then refuses — which reads as a broken login.
    await platformUser("norole@serveos.com");

    const res = await authenticatePlatformAdmin("norole@serveos.com", "pw1234");

    expect(res).toEqual({ ok: false, reason: "not_admin" });
  });

  it("rejects a wrong password", async () => {
    const u = await platformUser("pw@serveos.com");
    await grantSuperAdmin(u.id);

    const res = await authenticatePlatformAdmin("pw@serveos.com", "wrong");

    expect(res).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("rejects an unknown email", async () => {
    const res = await authenticatePlatformAdmin("nobody@serveos.com", "pw1234");

    expect(res).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("ignores a tenant-scoped user with the same email", async () => {
    const [t] = await db
      .insert(tenants)
      .values({ name: "R", slug: "r-login", country: "EG", vertical: "restaurant" })
      .returning();
    await db
      .insert(users)
      .values({ tenantId: t.id, name: "Owner", email: "dup@serveos.com", passwordHash: await hashPassword("pw1234") });

    const res = await authenticatePlatformAdmin("dup@serveos.com", "pw1234");

    expect(res).toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("rejects a platform user with no password hash", async () => {
    await db.insert(users).values({ tenantId: null, name: "No Pw", email: "nopw@serveos.com" });

    const res = await authenticatePlatformAdmin("nopw@serveos.com", "pw1234");

    expect(res).toEqual({ ok: false, reason: "invalid_credentials" });
  });
});
