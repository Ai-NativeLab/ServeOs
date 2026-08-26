import { NextResponse } from "next/server";
import { requireDashboardUser, authorizeDashboardOrRedirect } from "@/server/auth/dashboard-context";
import type { DashboardContext } from "@/server/auth/dashboard-context";
import { authorize, UnauthorizedError } from "@/server/rbac/authorize";
import type { Permission } from "@/server/rbac/permissions";

/**
 * Gates every inventory surface. Staff hold `inventory:view` and
 * `inventory:count` but never `inventory:manage` — they count shelves, they do
 * not re-cost or reconfigure stock.
 */
export async function requireInventoryPermission(perm: Permission): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  await authorizeDashboardOrRedirect(ctx, perm);
  return ctx;
}

/** requireDashboardUser signals "no session" by throwing redirect("/login"). */
const isLoginRedirect = (e: unknown): boolean =>
  typeof (e as { digest?: unknown } | null)?.digest === "string" &&
  (e as { digest: string }).digest.startsWith("NEXT_REDIRECT");

/**
 * Resolves the context for a route, or the response to return instead.
 *
 * Every inventory route needs the same shape — authorize, translate
 * UnauthorizedError to 403 and a missing session to 401. The login redirect
 * requireDashboardUser throws is right for pages but wrong for an API caller,
 * which would see an opaque 307 to an HTML login form instead of a status it
 * can act on. Ten hand-written copies of this ladder is ten chances to catch
 * too broadly.
 */
export async function resolveInventoryContext(
  perm: Permission,
): Promise<{ ctx: DashboardContext; denied: null } | { ctx: null; denied: NextResponse }> {
  try {
    return { ctx: await requireInventoryPermission(perm), denied: null };
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return { ctx: null, denied: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    if (isLoginRedirect(e)) {
      return { ctx: null, denied: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
    }
    throw e;
  }
}
