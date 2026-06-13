import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { roles, userRoles } from "./schema";
import type { RoleKey } from "@/server/rbac";

export const SESSION_COOKIE = "serveos_session";

export async function loadUserRoleKeys(userId: string): Promise<RoleKey[]> {
  const rows = await db
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.key as RoleKey);
}
