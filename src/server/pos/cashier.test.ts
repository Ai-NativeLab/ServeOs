import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { hashPassword } from "@/server/auth/password";
import { signInCashier, resolveCashier } from "./cashier";
import { PosCashierError } from "./errors";

let n = 0;

async function seedUser(roleKey: "owner" | "staff") {
  const [t] = await db.insert(tenants).values({
    slug: `pos-cashier-${n++}`, name: "T", country: "EG", vertical: "restaurant",
  }).returning();
  const [u] = await db.insert(users).values({
    tenantId: t.id, name: "Cash Ier", email: `c${n}@x.com`,
    passwordHash: await hashPassword("pw123456"), status: "active",
  }).returning();
  const [r] = await db.insert(roles).values({ tenantId: t.id, key: roleKey, name: roleKey }).returning();
  await db.insert(userRoles).values({ userId: u.id, roleId: r.id });
  return { tenantId: t.id, userId: u.id, email: u.email! };
}

describe("signInCashier", () => {
  it("returns a token and the owner's POS permissions", async () => {
    const { tenantId, email } = await seedUser("owner");
    const res = await signInCashier(tenantId, email, "pw123456");
    expect(res.cashierToken).toBeTruthy();
    expect(res.permissions).toContain("pos:discount");
  });

  it("gives staff pos:sell but not pos:discount", async () => {
    const { tenantId, email } = await seedUser("staff");
    const res = await signInCashier(tenantId, email, "pw123456");
    expect(res.permissions).toContain("pos:sell");
    expect(res.permissions).not.toContain("pos:discount");
  });

  it("rejects a wrong password", async () => {
    const { tenantId, email } = await seedUser("staff");
    await expect(signInCashier(tenantId, email, "wrong")).rejects.toThrow(PosCashierError);
  });

  it("resolves a signed-in cashier from their token", async () => {
    const { tenantId, email, userId } = await seedUser("owner");
    const { cashierToken } = await signInCashier(tenantId, email, "pw123456");
    const resolved = resolveCashier(cashierToken);
    expect(resolved?.userId).toBe(userId);
    expect(resolved?.tenantId).toBe(tenantId);
  });

  it("does not resolve an unknown token", () => {
    expect(resolveCashier("nope")).toBeNull();
  });
});
