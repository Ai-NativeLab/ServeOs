import { requirePosDevice } from "./require-device";
import { resolveCashier } from "./cashier";
import { PosCashierError, PosForbiddenError } from "./errors";
import type { Permission } from "@/server/rbac/permissions";

export type PosCashierContext = {
  deviceId: string;
  tenantId: string;
  branchId: string;
  cashierUserId: string;
  cashierName: string;
  permissions: Permission[];
};

/**
 * Resolves BOTH identities behind a POS request: the terminal (device token in
 * `Authorization: Bearer`) and the human (cashier token in `X-POS-Cashier`).
 * Throws PosAuthError for a bad device, PosCashierError for a bad cashier.
 */
export async function requirePosCashier(req: Request): Promise<PosCashierContext> {
  const device = await requirePosDevice(req);
  const token = req.headers.get("x-pos-cashier")?.trim() ?? "";
  const session = token ? resolveCashier(token) : null;
  if (!session) throw new PosCashierError("Cashier not signed in");

  // A cashier token minted for another tenant must never work on this device.
  if (session.tenantId !== device.tenantId) throw new PosCashierError("Cashier not signed in");

  return {
    deviceId: device.deviceId,
    tenantId: device.tenantId,
    branchId: device.branchId,
    cashierUserId: session.userId,
    cashierName: session.name,
    permissions: session.permissions,
  };
}

/** Server-side gate. The UI hiding a button is an affordance; this is the control. */
export function assertPermission(ctx: PosCashierContext, permission: Permission): void {
  if (!ctx.permissions.includes(permission)) throw new PosForbiddenError(permission);
}
