import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users, roles, userRoles } from "./schema";
import { tenants } from "@/server/tenancy/schema";
import { hashPassword } from "./password";
import { authenticatePlatformAdmin, setPlatformAdminPassword } from "./admin-login";

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

describe("setPlatformAdminPassword", () => {
  it("accepts the new password and stops accepting the old one", async () => {
    const u = await platformUser("rotate@serveos.com", "oldpassword");
    await grantSuperAdmin(u.id);

    await setPlatformAdminPassword("rotate@serveos.com", "n3w-p4ssw0rd");

    expect(await authenticatePlatformAdmin("rotate@serveos.com", "n3w-p4ssw0rd")).toMatchObject({ ok: true });
    // The half that matters for a rotation: the leaked value must stop working.
    expect(await authenticatePlatformAdmin("rotate@serveos.com", "oldpassword")).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("stores a hash, never the password itself", async () => {
    const u = await platformUser("hash@serveos.com");

    await setPlatformAdminPassword("hash@serveos.com", "plaintext-secret");

    const [row] = await db.select().from(users).where(eq(users.id, u.id));
    expect(row.passwordHash).not.toContain("plaintext-secret");
    expect(row.passwordHash?.length).toBeGreaterThan(20);
  });

  it("refuses a tenant-scoped user, so a rotation cannot hit the wrong account", async () => {
    const [t] = await db
      .insert(tenants)
      .values({ name: "R", slug: "r-rotate", country: "EG", vertical: "restaurant" })
      .returning();
    await db
      .insert(users)
      .values({ tenantId: t.id, name: "Owner", email: "scoped@serveos.com", passwordHash: "x" });

    await expect(setPlatformAdminPassword("scoped@serveos.com", "whatever")).rejects.toThrow(/no platform user/i);
  });
});
