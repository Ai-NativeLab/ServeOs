import { sha256Hex } from "@/server/audit/canonical";

/**
 * SHA-256 of a raw bearer token, hex-encoded. Control-plane tables (cashier
 * sessions, and grants) store only this — the raw token is returned to
 * the client once and never persisted, so a read-only DB leak can't hand out
 * live sessions.
 */
export function tokenHash(token: string): string {
  return sha256Hex(token);
}
