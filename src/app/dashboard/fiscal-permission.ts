import { NextResponse } from "next/server";
import { requireDashboardUser, type DashboardContext } from "@/server/auth/dashboard-context";
import { authorize, UnauthorizedError } from "@/server/rbac/authorize";

/**
 * Gates every ETA fiscal surface — the config dashboard, the device
 * credentials, the submission feed and the resubmission trigger.
 *
 * `fiscal:manage` is OWNER ONLY, deliberately narrower than `audit:view` or
 * `tenant:manage`: this surface names the taxpayer, points at the credential
 * store and fixes the branch identity every legal receipt is issued under.
 * Submitting a document needs no permission at all — the worker does that as a
 * system action (F8).
 *
 * Mirrors `./audit-permission`: `requireDashboardUser` (which redirects an
 * unauthenticated caller to /login) then `authorize`, which throws
 * `UnauthorizedError` a page can render as a "not authorized" panel.
 */
export async function requireFiscalPermission(): Promise<DashboardContext> {
  const ctx = await requireDashboardUser();
  authorize(ctx.roleKeys, "fiscal:manage");
  return ctx;
}

/** `requireDashboardUser` signals "no session" by throwing `redirect("/login")`. */
const isLoginRedirect = (e: unknown): boolean =>
  typeof (e as { digest?: unknown } | null)?.digest === "string" &&
  (e as { digest: string }).digest.startsWith("NEXT_REDIRECT");

/**
 * The route-handler form of the gate: the context, or the response to return
 * instead — 403 for a signed-in user without `fiscal:manage`, 401 for no
 * session at all.
 *
 * Same ladder as `./purchasing-permission`'s `resolvePurchasingContext`, and it
 * exists for the same reason: `requireFiscalPermission` alone would answer an
 * API caller with a 307 to the HTML login form, which a fetch cannot act on.
 */
export async function resolveFiscalContext(): Promise<
  { ctx: DashboardContext; denied: null } | { ctx: null; denied: NextResponse }
> {
  try {
    return { ctx: await requireFiscalPermission(), denied: null };
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
