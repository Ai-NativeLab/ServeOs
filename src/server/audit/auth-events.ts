import { withTenant } from "@/db/with-tenant";
import { recordAuditEvent, type AuditFingerprint } from "./service";

export type AuthAction = "auth.login" | "auth.login_failed" | "auth.logout";

const SUMMARY: Record<AuthAction, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in",
  "auth.logout": "Signed out",
};

/**
 * Appends one auth event at the action boundary (login / logout / failed login).
 * Auth has no data write to bind to, so this opens its own one-statement
 * withTenant append. A failed login records a null actorUserId and keeps the
 * attempted email in metadata; a success or logout records the user.
 */
export async function recordAuthEvent(
  tenantId: string,
  action: AuthAction,
  opts: { actorUserId: string | null; email?: string; fingerprint: AuditFingerprint },
): Promise<void> {
  await withTenant(tenantId, (tx) => recordAuditEvent(
    { tenantId, actorUserId: opts.actorUserId, fingerprint: opts.fingerprint },
    {
      action,
      entityType: opts.actorUserId ? "user" : "auth",
      entityId: opts.actorUserId ?? opts.email ?? "unknown",
      summary: opts.email ? `${SUMMARY[action]} (${opts.email})` : SUMMARY[action],
      metadata: opts.email ? { email: opts.email } : {},
      actorType: opts.actorUserId ? "user" : "system",
    },
    tx,
  ));
}
