import { and, eq, ne, or } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import { users, roles, userRoles, sessions, type User } from "./schema";
import { hashPassword } from "./password";
import { StaffContactTakenError } from "./errors";
import { getOrCreateRole } from "./roles";

export type StaffRoleKey = "manager" | "staff";
export type StaffMember = {
  id: string; name: string; email: string | null; phone: string | null; status: string; roleKey: StaffRoleKey;
};
export type CreateStaffInput = { name: string; email?: string; phone?: string; password: string; roleKey: StaffRoleKey };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function getOrCreateTenantRole(tx: Tx, tenantId: string, key: StaffRoleKey): Promise<{ id: string }> {
  return getOrCreateRole(tx, tenantId, key, key === "manager" ? "Manager" : "Staff");
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

export async function createStaff(tenantId: string, input: CreateStaffInput, audit?: AuditActorInput): Promise<User> {
  const email = input.email?.trim() || null;
  const phone = input.phone?.trim() || null;
  if (!email && !phone) throw new Error("Staff member needs an email or phone");

  const contactConditions = [
    email ? eq(users.email, email) : null,
    phone ? eq(users.phone, phone) : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);

  // withTenant (not db.transaction): control tables have no RLS, so the writes
  // are unaffected, and the audit insert now has app.tenant_id.
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), or(...contactConditions)))
      .limit(1);
    if (existing) throw new StaffContactTakenError(email ?? phone!);

    const passwordHash = await hashPassword(input.password);
    const role = await getOrCreateTenantRole(tx, tenantId, input.roleKey);

    const [user] = await tx.insert(users).values({ tenantId, name: input.name, email, phone, passwordHash }).returning();
    await tx.insert(userRoles).values({ userId: user.id, roleId: role.id });
    await recordAuditEvent(
      { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "staff.invited", entityType: "staff", entityId: user.id,
        summary: `Staff "${input.name}" invited as ${input.roleKey}`,
        metadata: { roleKey: input.roleKey, actorRoleKey: audit?.roleKey ?? null }, actorType: audit?.actorType },
      tx,
    );
    return user;
  });
}

export async function setStaffRole(tenantId: string, userId: string, roleKey: StaffRoleKey, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [target] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenantId))).limit(1);
    if (!target) throw new Error("Staff member not found");
    const [beforeRole] = await tx.select({ key: roles.key })
      .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId)).limit(1);
    const role = await getOrCreateTenantRole(tx, tenantId, roleKey);
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    await tx.insert(userRoles).values({ userId, roleId: role.id });
    await recordAuditEvent(
      { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "staff.role_changed", entityType: "staff", entityId: userId,
        summary: `Role ${beforeRole?.key ?? "?"} → ${roleKey}`,
        metadata: { before: beforeRole?.key ?? null, after: roleKey, actorRoleKey: audit?.roleKey ?? null }, actorType: audit?.actorType },
      tx,
    );
  });
}

export async function deactivateStaff(tenantId: string, userId: string, audit?: AuditActorInput): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [target] = await tx
      .update(users)
      .set({ status: "inactive" })
      .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)))
      .returning({ id: users.id });
    if (!target) throw new Error("Staff member not found");
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await recordAuditEvent(
      { tenantId, actorUserId: audit?.actorUserId ?? null, fingerprint: audit?.fingerprint ?? emptyFingerprint() },
      { action: "staff.deactivated", entityType: "staff", entityId: userId,
        summary: `Staff deactivated`, metadata: { sessionsRevoked: true, actorRoleKey: audit?.roleKey ?? null }, actorType: audit?.actorType },
      tx,
    );
  });
}
