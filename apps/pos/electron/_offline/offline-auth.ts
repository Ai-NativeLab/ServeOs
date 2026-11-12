import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";
// Dependency-free (no db/schema imports), so pulling it into the Electron
// main bundle costs nothing — this is the single source of truth for valid
// permission strings, reused rather than duplicated so the offline check
// below can never drift from the server's own PERMISSIONS list.
import { PERMISSIONS, type Permission } from "../../../../src/server/rbac/permissions";

/**
 * Must stay byte-for-byte identical to src/server/auth/password.ts's
 * verifyPassword: same `salt:hex(64-byte-key)` wire format, same scrypt call
 * (password, salt-as-utf8-string, 64), same defaults for cost/block/
 * parallelization (neither side overrides them). Sync rather than the
 * server's promisified version — offline sign-in resolves without an event
 * loop trip — but `scryptSync`/`scrypt` are the same algorithm with the same
 * defaults, so outputs are identical for the same inputs. Proven in
 * offline-auth.test.ts against the server's own exported hashPassword, not
 * just this file's own hash — a hand-rolled fixture here would only prove
 * this file agrees with itself.
 */
const SCRYPT_KEYLEN = 64;

function verifyScryptHash(password: string, stored: string): boolean {
  const [salt, key] = stored.split(":");
  if (!salt || !key) return false;
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  const keyBuf = Buffer.from(key, "hex");
  // Length check first: timingSafeEqual throws on mismatched lengths rather
  // than returning false, and a length mismatch is already conclusive.
  return keyBuf.length === derived.length && timingSafeEqual(keyBuf, derived);
}

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export type OfflineCashierSession = {
  userId: string;
  name: string;
  email: string;
  permissions: string[];
};

/**
 * Offline sign-in against the synced roster (`auth_cache`, replaced wholesale
 * on every pull — Task 8's saveAuthRoster). This is a local credential check
 * the till already trusts, never a live session: mints no server token,
 * just the identity + permissions the caller (pos-main.ts) keeps in memory
 * for the rest of the shift.
 *
 * Every outcome that names a real user appends `session.signed_in` (success
 * AND a wrong-password attempt) so it replays into the server audit chain
 * on reconnect — offline activity must not be invisible to history. An email
 * with no roster match is the one case that appends nothing: the server's
 * `actorUserId` is a mandatory UUID naming a real tenant user (sync-ingest's
 * validateEnvelope), so there is no valid event to build — emitting one
 * anyway would fail server validation on replay and, per the sync engine's
 * sticky-halt rule, jam every event queued behind it with no way to fix it
 * after the fact. The real till UI reflects this by picking a cached
 * cashier rather than free-typing an email offline.
 */
export function offlineSignIn(store: Store, email: string, password: string): OfflineCashierSession | null {
  const user = store.findAuthUser(email);
  if (!user) return null;

  const verified = verifyScryptHash(password, user.passwordHash);
  store.appendEvent("session.signed_in", {
    actorUserId: user.userId,
    outcome: verified ? "success" : "failed",
  });

  if (!verified) return null;
  return { userId: user.userId, name: user.name, email: user.email, permissions: user.permissions };
}

export type OfflineGrant = {
  token: string;
  permission: Permission;
  authorizedByUserId: string;
};

type GrantRecord = { permission: Permission; authorizedByUserId: string; expiresAt: number };

/** One device's outstanding offline grants. Electron main memory only — like
 *  the cashier session above, it never needs to survive a restart, and there
 *  is exactly one reader (this process). */
export type OfflineGrantVault = Map<string, GrantRecord>;

export function createGrantVault(): OfflineGrantVault {
  return new Map();
}

// Mirrors grants.ts's GRANT_TTL_MS: long enough for the manager to hand the
// till back, short enough to be useless if the token is left lying around.
const GRANT_TTL_MS = 2 * 60 * 1000;

/**
 * Offline stand-in for the live `/authorize` route: verifies the authorizer
 * against the synced roster and — unlike the server's own
 * resolveOfflineAuthorizer, which deliberately does NOT re-check the
 * permission on replay (grants.ts: "the permission itself was already
 * enforced live at the till when this happened") — this is the one place
 * that check actually happens for an offline grant. Get it wrong here and
 * nothing downstream catches it.
 *
 * `grant.issued` gates nothing by itself (client wire contract rule 3); it
 * is only ever the audit record of a successful authorization, so this
 * appends the event on success alone — the server has no "failed grant"
 * event or outcome to record (asGrantIssuedPayload takes just
 * `{ permission }`), matching a live 403 leaving no grant row behind either.
 * `actorUserId` is the signed-in cashier the grant is FOR (who the gated
 * action belongs to), distinct from `authorizedByUserId`, the manager who
 * approved it — the caller supplies the former since offline-auth.ts holds
 * no session state of its own.
 *
 * Returns a single-use local token: the caller attaches the returned
 * `authorizedByUserId` to the NEXT gated event's payload directly, or holds
 * the token and calls `consumeOfflineGrant` when that event is actually
 * built (Task 10's write-through wiring uses the latter).
 */
export function offlineGrant(
  store: Store,
  vault: OfflineGrantVault,
  actorUserId: string,
  authorizerEmail: string,
  authorizerPassword: string,
  permission: string,
): OfflineGrant | null {
  if (!isPermission(permission)) return null;

  const authorizer = store.findAuthUser(authorizerEmail);
  if (!authorizer) return null;
  if (!verifyScryptHash(authorizerPassword, authorizer.passwordHash)) return null;
  if (!authorizer.permissions.includes(permission)) return null;

  store.appendEvent("grant.issued", {
    actorUserId,
    authorizedByUserId: authorizer.userId,
    permission,
  });

  const token = randomBytes(24).toString("hex");
  vault.set(token, { permission, authorizedByUserId: authorizer.userId, expiresAt: Date.now() + GRANT_TTL_MS });
  return { token, permission, authorizedByUserId: authorizer.userId };
}

/**
 * Files a grant the LIVE `/authorize` route minted under its own token, so one
 * token satisfies both worlds: the server-backed routes that still redeem it
 * (refunds) and the event payloads that need the manager's id. Necessary
 * because the live route answers with the manager's NAME, never their id —
 * the id here comes from the same roster check `offlineGrant` does.
 */
export function rememberGrant(
  vault: OfflineGrantVault,
  token: string,
  permission: string,
  authorizedByUserId: string,
): void {
  if (!isPermission(permission)) return;
  vault.set(token, { permission, authorizedByUserId, expiresAt: Date.now() + GRANT_TTL_MS });
}

/**
 * Single-use: deletes on read whether or not it matches, mirroring
 * grants.ts's consumeGrant — a redemption attempt against the wrong
 * permission still burns the token instead of leaving it replayable.
 */
export function consumeOfflineGrant(vault: OfflineGrantVault, token: string, permission: string): string | null {
  const record = vault.get(token);
  vault.delete(token);
  if (!record || record.expiresAt <= Date.now() || record.permission !== permission) return null;
  return record.authorizedByUserId;
}
