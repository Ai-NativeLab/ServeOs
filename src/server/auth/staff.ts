import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { users, roles, userRoles, sessions, type User } from "./schema";
import { hashPassword } from "./password";
import { StaffContactTakenError } from "./errors";

export type StaffRoleKey = "manager" | "staff";
export type StaffMember = {
  id: string; name: string; email: string | null; phone: string | null; status: string; roleKey: StaffRoleKey;
};
export type CreateStaffInput = { name: string; email?: string; phone?: string; password: string; roleKey: StaffRoleKey };

async function getOrCreateTenantRole(tenantId: string, key: StaffRoleKey): Promise<{ id: string }> {
  const [existing] = await db.select().from(roles).where(and(eq(roles.tenantId, tenantId), eq(roles.key, key))).limit(1);
  if (existing) return existing;
  const name = key === "manager" ? "Manager" : "Staff";
  const [created] = await db.insert(roles).values({ tenantId, key, name }).returning();
  return created;
}

export async function listStaff(tenantId: string): Promise<StaffMember[]> {
  const rows = await db
    .select({ user: users, roleKey: roles.key })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.tenantId, tenantId), ne(roles.key, "owner")));
  return rows.map((r) => ({
    id: r.user.id, name: r.user.name, email: r.user.email, phone: r.user.phone,
    status: r.user.status, roleKey: r.roleKey as StaffRoleKey,
  }));
}

export async function createStaff(tenantId: string, input: CreateStaffInput): Promise<User> {
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  if (!email && !phone) throw new Error("Staff member needs an email or phone");

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), email ? eq(users.email, email) : eq(users.phone, phone!)))
    .limit(1);
  if (existing) throw new StaffContactTakenError(email ?? phone!);

  const passwordHash = await hashPassword(input.password);
  const role = await getOrCreateTenantRole(tenantId, input.roleKey);

  const [user] = await db.insert(users).values({ tenantId, name: input.name, email, phone, passwordHash }).returning();
  await db.insert(userRoles).values({ userId: user.id, roleId: role.id });
  return user;
}

export async function setStaffRole(tenantId: string, userId: string, roleKey: StaffRoleKey): Promise<void> {
  const [target] = await db.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId))).limit(1);
  if (!target) throw new Error("Staff member not found");
  const role = await getOrCreateTenantRole(tenantId, roleKey);
  await db.delete(userRoles).where(eq(userRoles.userId, userId));
  await db.insert(userRoles).values({ userId, roleId: role.id });
}

export async function deactivateStaff(tenantId: string, userId: string): Promise<void> {
  const [target] = await db
    .update(users)
    .set({ status: "inactive" })
    .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
    .returning({ id: users.id });
  if (!target) throw new Error("Staff member not found");
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
