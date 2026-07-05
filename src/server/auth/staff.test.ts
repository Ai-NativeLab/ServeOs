import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/server/tenancy/schema";
import { users, sessions, roles, userRoles } from "./schema";
import { createSession } from "./session";
import { createStaff, listStaff, setStaffRole, deactivateStaff } from "./staff";
import { StaffContactTakenError } from "./errors";

async function makeTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  return t;
}

describe("staff management", () => {
  it("creates a staff member with a tenant-scoped role", async () => {
    const t = await makeTenant("staff-create");
    const user = await createStaff(t.id, { name: "Nour", email: "nour@roma.com", password: "pass1234", roleKey: "manager" });
    const staff = await listStaff(t.id);
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ id: user.id, name: "Nour", roleKey: "manager", status: "active" });
  });

  it("rejects a duplicate email within the same tenant", async () => {
    const t = await makeTenant("staff-dup");
    await createStaff(t.id, { name: "Nour", email: "dup@roma.com", password: "pass1234", roleKey: "staff" });
    await expect(
      createStaff(t.id, { name: "Karim", email: "dup@roma.com", password: "pass1234", roleKey: "staff" }),
    ).rejects.toBeInstanceOf(StaffContactTakenError);
  });

  it("changes a staff member's role", async () => {
    const t = await makeTenant("staff-role");
    const user = await createStaff(t.id, { name: "Nour", email: "role@roma.com", password: "pass1234", roleKey: "staff" });
    await setStaffRole(t.id, user.id, "manager");
    const staff = await listStaff(t.id);
    expect(staff[0].roleKey).toBe("manager");
  });

  it("deactivates a staff member and clears their sessions", async () => {
    const t = await makeTenant("staff-deactivate");
    const user = await createStaff(t.id, { name: "Nour", email: "deact@roma.com", password: "pass1234", roleKey: "staff" });
    await createSession(user.id);
    await deactivateStaff(t.id, user.id);

    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    expect(row.status).toBe("inactive");
    const remainingSessions = await db.select().from(sessions).where(eq(sessions.userId, user.id));
    expect(remainingSessions).toHaveLength(0);
  });

  it("excludes the owner from the staff list", async () => {
    const t = await makeTenant("staff-owner-excl");
    const [owner] = await db.insert(users).values({ tenantId: t.id, name: "Owner", email: "owner@roma.com", passwordHash: "x" }).returning();
    const [ownerRole] = await db.insert(roles).values({ tenantId: t.id, key: "owner", name: "Owner" }).returning();
    await db.insert(userRoles).values({ userId: owner.id, roleId: ownerRole.id });
    await createStaff(t.id, { name: "Nour", email: "staffmember@roma.com", password: "pass1234", roleKey: "staff" });

    const staff = await listStaff(t.id);
    expect(staff).toHaveLength(1);
    expect(staff[0].name).toBe("Nour");
  });
});
