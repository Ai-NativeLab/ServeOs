import { requirePosDevice } from "./require-device";
import { resolveCashier } from "./cashier";
import { PosCashierError, PosForbiddenError } from "./errors";
import { sha256Hex } from "@/server/audit/canonical";
import { headersFingerprint } from "@/server/audit/fingerprint";
import type { AuditFingerprint } from "@/server/audit/service";
import type { Permission } from "@/server/rbac/permissions";

export type PosCashierContext = {
  deviceId: string;
  tenantId: string;
  branchId: string;
  cashierUserId: string;
  cashierName: string;
  permissions: Permission[];
  fingerprint: AuditFingerprint;
};

/**
 * Resolves BOTH identities behind a POS request: the terminal (device token in
 * `Authorization: Bearer`) and the human (cashier token in `X-POS-Cashier`).
 * Throws PosAuthError for a bad device, PosCashierError for a bad cashier.
 */
export async function requirePosCashier(req: Request): Promise<PosCashierContext> {
  const device = await requirePosDevice(req);
  const token = req.headers.get("x-pos-cashier")?.trim() ?? "";
  const session = token ? await resolveCashier(token) : null;
  if (!session) throw new PosCashierError("Cashier not signed in");

  // A cashier token minted for another tenant must never work on this device.
  if (session.tenantId !== device.tenantId) throw new PosCashierError("Cashier not signed in");

  const bearer = req.headers.get("authorization") ?? "";
  const deviceToken = bearer.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  const fingerprint: AuditFingerprint = {
    // ip + userAgent (incl. the x-real-ip fallback) come from the shared helper;
    // POS overrides the device fields + app version below.
    ...headersFingerprint(req.headers),
    deviceId: device.deviceId,
    // Hash of whatever token was valid at capture time — raw token never stored.
    deviceTokenHash: deviceToken ? sha256Hex(deviceToken) : null,
    // Missing on older POS builds → null; we still audit (never block a sale).
    appVersion: req.headers.get("x-pos-app-version")?.trim() || null,
  };

  return {
    deviceId: device.deviceId,
    tenantId: device.tenantId,
    branchId: device.branchId,
    cashierUserId: session.userId,
    cashierName: session.name,
    permissions: session.permissions,
    fingerprint,
  };
}

/** Server-side gate. The UI hiding a button is an affordance; this is the control. */
export function assertPermission(ctx: PosCashierContext, permission: Permission): void {
  if (!ctx.permissions.includes(permission)) throw new PosForbiddenError(permission);
}
