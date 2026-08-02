import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { roles } from "./schema";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Returns the role for `(tenantId, key)`, creating it if absent. Pass
 * `tenantId: null` for a platform role.
 *
 * Race-safe by construction rather than by luck. Select-then-insert lets two
 * concurrent callers both find nothing and both insert, which used to leave a
 * user holding the same role twice via two different role rows. Here the insert
 * goes first and defers to the unique indexes; a loser gets no row back and
 * reads the winner's instead.
 */
export async function getOrCreateRole(
  exec: Executor,
  tenantId: string | null,
  key: string,
  name: string,
): Promise<{ id: string }> {
  const [created] = await exec
    .insert(roles)
    .values({ tenantId, key, name })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  const [existing] = await exec
    .select()
    .from(roles)
    .where(and(tenantId === null ? isNull(roles.tenantId) : eq(roles.tenantId, tenantId), eq(roles.key, key)))
    .limit(1);
  return existing;
}
