import { NextResponse } from "next/server";
import { requireDashboardUser, authorizeDashboardOrRedirect } from "@/server/auth/dashboard-context";
import type { DashboardContext } from "@/server/auth/dashboard-context";
import { authorize, UnauthorizedError } from "@/server/rbac/authorize";
import type { Permission } from "@/server/rbac/permissions";
import { branches } from "@/server/branches/schema";
import { tenants } from "@/server/tenancy/schema";
import { withTenant } from "@/db/with-tenant";
import { NoBranchError } from "@/server/purchasing/errors";
import { eq } from "drizzle-orm";
import type { VerticalId } from "@/server/verticals/types";
import type { PurchasingActor } from "@/server/purchasing/suppliers";

/**
 * Gates every suppliers + purchase-orders surface (owner/manager only — staff
 * hold neither `purchasing:manage` nor `suppliers:manage`).
 */
export async function requirePurchasingPermission(perm: Permission): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  await authorizeDashboardOrRedirect(ctx, perm);
  return ctx;
}

export const requireSuppliersPermission = requirePurchasingPermission;

/** requireDashboardUser signals "no session" by throwing redirect("/login"). */
const isLoginRedirect = (e: unknown): boolean =>
  typeof (e as { digest?: unknown } | null)?.digest === "string" &&
  (e as { digest: string }).digest.startsWith("NEXT_REDIRECT");

/**
 * Resolves the dashboard context for a route, or the response to return
 * instead (403 for a missing permission, 401 for no session) — the same ladder
 * inventory-permission.ts uses, so an API caller gets a status it can act on
 * instead of an opaque redirect to the HTML login form.
 */
export async function resolvePurchasingContext(
  perm: Permission,
): Promise<{ ctx: DashboardContext; denied: null } | { ctx: null; denied: NextResponse }> {
  try {
    return { ctx: await requirePurchasingPermission(perm), denied: null };
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

/**
 * Builds the PurchasingActor for a dashboard request. `branchId` and `vertical`
 * are derived server-side from the tenant — never trusted from the request body:
 * the dashboard user's session carries no branch, and a client-supplied branch
 * would let a caller attribute an audit row (and the PO) to another branch.
 */
export async function resolvePurchasingActor(ctx: DashboardContext): Promise<PurchasingActor> {
  const { branchId, vertical } = await withTenant(ctx.tenantId, async (tx) => {
    const [branch] = await tx.select({ id: branches.id }).from(branches).orderBy(branches.sortOrder).limit(1);
    const [t] = await tx.select({ vertical: tenants.vertical }).from(tenants).where(eq(tenants.id, ctx.tenantId)).limit(1);
    // A tenant with no branch cannot own a PO (branch_id is a NOT NULL uuid FK)
    // and cannot be audited against one. Failing here with a clear domain error
    // beats `?? ""` reaching a uuid column as `invalid input syntax` -> 500.
    if (!branch) throw new NoBranchError();
    return { branchId: branch.id, vertical: (t?.vertical ?? "restaurant") as VerticalId };
  });
  return { tenantId: ctx.tenantId, branchId, actorUserId: ctx.user.id, vertical };
}
