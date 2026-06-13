import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { users, roles, userRoles } from "./schema";
import { loadUserRoleKeys, SESSION_COOKIE } from "./current-user";

describe("current-user helpers", () => {
  it("exposes a stable session cookie name", () => {
    expect(SESSION_COOKIE).toBe("serveos_session");
  });

  it("loads a user's role keys", async () => {
    const [u] = await db.insert(users).values({ tenantId: null, name: "X", email: "x@x.com" }).returning();
    const [r] = await db.insert(roles).values({ tenantId: null, key: "super_admin", name: "Super Admin" }).returning();
    await db.insert(userRoles).values({ userId: u.id, roleId: r.id });
    expect(await loadUserRoleKeys(u.id)).toEqual(["super_admin"]);
  });

  it("returns an empty array for a user with no roles", async () => {
    const [u] = await db.insert(users).values({ tenantId: null, name: "Y", email: "y@y.com" }).returning();
    expect(await loadUserRoleKeys(u.id)).toEqual([]);
  });
});
