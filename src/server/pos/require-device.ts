import { resolveDevice } from "./service";
import { PosAuthError } from "./errors";

/** The terminal's own identity — deliberately NOT a cashier session (see
 *  PosCashierContext). What sync-ingest.ts authenticates the whole batch
 *  against: every event inside still carries its own actorUserId. */
export type PosDeviceContext = { deviceId: string; tenantId: string; branchId: string; createdByUserId: string };

/**
 * Resolves the POS device behind a request's `Authorization: Bearer <token>` header.
 * Throws PosAuthError if the token is missing, unknown, or revoked.
 */
export async function requirePosDevice(req: Request): Promise<PosDeviceContext> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const device = token ? await resolveDevice(token) : null;
  if (!device) throw new PosAuthError();
  return device;
}
