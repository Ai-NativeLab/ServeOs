import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { users, roles, userRoles } from "./schema";
import { getOrCreateRole } from "./roles";

export type EnsureSuperAdminResult = {
  userId: string;
  /** The platform role row had to be created. */
  roleCreated: boolean;
  /** This user was not linked to super_admin before now. */
  roleGranted: boolean;
};

/**
 * Makes sure the platform user `email` actually holds `super_admin`.
 *
 * Provisioning the role and provisioning the user are separate steps, and a run
 * that creates the user but not the role leaves an admin who can authenticate
 * but fails every authorization check — and any create-if-missing seed skips
 * them from then on. This closes that gap and is safe to run repeatedly.
 */
export async function ensurePlatformSuperAdmin(email: string): Promise<EnsureSuperAdminResult> {
  return db.transaction(async (tx) => {
    // tenantId IS NULL distinguishes a platform user from a tenant member who
    // happens to share the address.
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.tenantId)))
      .limit(1);
    if (!user) throw new Error(`No platform user with email ${email}`);

    const [before] = await tx
      .select()
      .from(roles)
      .where(and(isNull(roles.tenantId), eq(roles.key, "super_admin")))
      .limit(1);
    const role = await getOrCreateRole(tx, null, "super_admin", "Super Admin");

    const [link] = await tx
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, user.id), eq(userRoles.roleId, role.id)))
      .limit(1);
    if (!link) await tx.insert(userRoles).values({ userId: user.id, roleId: role.id });

    return { userId: user.id, roleCreated: !before, roleGranted: !link };
  });
}
