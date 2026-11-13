import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users } from "./schema";
import { tenants } from "@/server/tenancy/schema";
import { findTenantUserByEmail } from "./tenant-login";

async function tenantWithUser(email: string) {
  const [t] = await db.insert(tenants).values({ slug: `t${Math.random().toString(36).slice(2, 8)}`, name: "T", country: "EG" }).returning();
  const [u] = await db.insert(users).values({ tenantId: t.id, name: "Owner", email }).returning();
  return { tenantId: t.id, userId: u.id };
}

describe("findTenantUserByEmail", () => {
  // Registration now stores the email lowercased (#204); the login form must
  // still find it when the owner types it the way they always have.
  it("finds a lowercased account when the email is typed with capitals and spaces", async () => {
    const { tenantId, userId } = await tenantWithUser("ahmed@roma.com");
    expect((await findTenantUserByEmail(tenantId, " Ahmed@Roma.COM "))?.id).toBe(userId);
  });

  // Accounts registered before #204 kept whatever casing was typed.
  it("still finds an older account stored with capitals", async () => {
    const { tenantId, userId } = await tenantWithUser("Sara@Roma.com");
    expect((await findTenantUserByEmail(tenantId, "sara@roma.com"))?.id).toBe(userId);
  });

  it("never matches a user in another tenant", async () => {
    await tenantWithUser("shared@roma.com");
    const { tenantId: other } = await tenantWithUser("someone@else.com");
    expect(await findTenantUserByEmail(other, "shared@roma.com")).toBeUndefined();
  });
});
