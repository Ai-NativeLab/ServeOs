import { describe, it, expect } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { roles } from "./schema";
import { tenants } from "@/server/tenancy/schema";
import { getOrCreateRole } from "./roles";

async function tenant(slug: string) {
  const [t] = await db
    .insert(tenants)
    .values({ name: "R", slug, country: "EG", vertical: "restaurant" })
    .returning();
  return t;
}

describe("getOrCreateRole", () => {
  it("creates a tenant role that does not exist yet", async () => {
    const t = await tenant("role-a");

    const role = await getOrCreateRole(db, t.id, "manager", "Manager");

    const rows = await db.select().from(roles).where(eq(roles.tenantId, t.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(role.id);
  });

  it("reuses an existing role instead of duplicating it", async () => {
    const t = await tenant("role-b");
    const first = await getOrCreateRole(db, t.id, "staff", "Staff");

    const second = await getOrCreateRole(db, t.id, "staff", "Staff");

    expect(second.id).toBe(first.id);
    expect(await db.select().from(roles).where(eq(roles.tenantId, t.id))).toHaveLength(1);
  });

  it("keeps platform roles separate from tenant roles of the same key", async () => {
    const t = await tenant("role-c");
    const platform = await getOrCreateRole(db, null, "super_admin", "Super Admin");
    const scoped = await getOrCreateRole(db, t.id, "super_admin", "Super Admin");

    expect(scoped.id).not.toBe(platform.id);
    const [onlyPlatform] = await db
      .select()
      .from(roles)
      .where(and(isNull(roles.tenantId), eq(roles.key, "super_admin")));
    expect(onlyPlatform.id).toBe(platform.id);
  });

  it("reuses an existing platform role", async () => {
    // NULL tenant_id is why this needs its own case: Postgres treats NULLs as
    // distinct, so the composite unique index never constrains platform roles.
    const first = await getOrCreateRole(db, null, "super_admin", "Super Admin");

    const second = await getOrCreateRole(db, null, "super_admin", "Super Admin");

    expect(second.id).toBe(first.id);
    expect(await db.select().from(roles).where(isNull(roles.tenantId))).toHaveLength(1);
  });

  it("does not create a second row when two callers race", async () => {
    const t = await tenant("role-d");

    const [a, b] = await Promise.all([
      getOrCreateRole(db, t.id, "manager", "Manager"),
      getOrCreateRole(db, t.id, "manager", "Manager"),
    ]);

    expect(a.id).toBe(b.id);
    expect(await db.select().from(roles).where(eq(roles.tenantId, t.id))).toHaveLength(1);
  });
});
