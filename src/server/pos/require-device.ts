import { resolveDevice } from "./service";
import { PosAuthError } from "./errors";

/**
 * Resolves the POS device behind a request's `Authorization: Bearer <token>` header.
 * Throws PosAuthError if the token is missing, unknown, or revoked.
 */
export async function requirePosDevice(
  req: Request,
): Promise<{ deviceId: string; tenantId: string; branchId: string; createdByUserId: string }> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const device = token ? await resolveDevice(token) : null;
  if (!device) throw new PosAuthError();
  return device;
}
