import { resolveDevice } from "./service";
import { PosAuthError, PosTenantBlockedError } from "./errors";
import { getTenantById } from "@/server/tenancy";

/** The terminal's own identity �?" deliberately NOT a cashier session (see
 *  PosCashierContext). What sync-ingest.ts authenticates the whole batch
 *  against: every event inside still carries its own actorUserId. */
export type PosDeviceContext = { deviceId: string; tenantId: string; branchId: string; createdByUserId: string };

/**
 * Resolves the POS device behind a request's `Authorization: Bearer <token>` header.
 * Throws PosAuthError if the token is missing, unknown, or revoked.
 *
 * #164: also refuses a device whose TENANT is not servable (suspended /
 * rejected / onboarding). Suspension must not leave a working till in the
 * field; this is the single choke point every POS v1 route authenticates
 * through, so one check covers login, catalog, orders, and sync alike.
 */
export async function requirePosDevice(req: Request): Promise<PosDeviceContext> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const device = token ? await resolveDevice(token) : null;
  if (!device) throw new PosAuthError();

  const tenant = await getTenantById(device.tenantId);
  if (!tenant || (tenant.status !== "active" && tenant.status !== "trial")) {
    throw new PosTenantBlockedError(tenant?.status ?? "unknown");
  }
  return device;
}
