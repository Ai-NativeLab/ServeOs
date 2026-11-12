import { eq, and } from "drizzle-orm";
import { withTenant, type Tx } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { etaTenantConfig, etaPosCredentials } from "./schema";
import { EtaConfigError } from "./eta-transport-errors";
import type { EtaConfig, EtaDeviceCredentials } from "./provider";

/**
 * THE TENANT-BOUND REF NAMESPACE.
 *
 * A ref names an environment variable, and the process environment is shared by
 * EVERY tenant and by the rest of the app — `DATABASE_URL`, `RESEND_API_KEY`,
 * another tenant's ETA secrets. Unrestricted, a ref saved by one tenant's
 * fiscal manager could point at any of those, and the worker would read it and
 * send it to ETA as a client secret or pre-shared key. So a ref may only name a
 * key in its OWN tenant's namespace:
 *
 *     env://ETA_<TENANT>__<NAME>
 *
 * `<TENANT>` is the tenant's slug upper-cased with `-` -> `_` (slugs are the
 * immutable subdomain, `[a-z0-9-]`); `<NAME>` is one or more `[A-Z0-9]` words
 * joined by SINGLE underscores, e.g. `CLIENT_SECRET`, `POS1_SECRET_1`.
 *
 * THE DOUBLE UNDERSCORE IS WHAT MAKES IT UNAMBIGUOUS. Slug `acme` owns
 * `ETA_ACME__…`; slug `acme--x` owns `ETA_ACME__X__…`. Because `<NAME>` may not
 * contain `__`, `ETA_ACME__X__CLIENT_SECRET` parses for `acme` only as NAME
 * `X__CLIENT_SECRET`, which is refused — no tenant can name a key in another
 * tenant's namespace, whichever slug is a prefix of which.
 *
 * Enforced on BOTH sides: the config service refuses to SAVE an out-of-namespace
 * ref (a form error naming the required prefix), and `resolveSecretRef` refuses
 * to RESOLVE one (a row written before this rule, or by some other path), so the
 * secret is never read, let alone sent.
 */
export function etaSecretKeyPrefix(tenantSlug: string): string {
  return `ETA_${tenantSlug.toUpperCase().replace(/-/g, "_")}__`;
}

/** The `env://` form of `etaSecretKeyPrefix` — what an operator types. */
export function etaSecretRefPrefix(tenantSlug: string): string {
  return `env://${etaSecretKeyPrefix(tenantSlug)}`;
}

const SECRET_NAME_RE = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/** The env KEY a ref names, with or without the `env://` scheme (legacy rows
 *  were stored bare). */
function refKey(ref: string): string {
  return ref.startsWith("env://") ? ref.slice("env://".length) : ref;
}

/** Whether `ref` names a key inside `tenantSlug`'s namespace. */
export function isTenantBoundSecretRef(ref: string, tenantSlug: string): boolean {
  const key = refKey(ref);
  const prefix = etaSecretKeyPrefix(tenantSlug);
  return key.startsWith(prefix) && SECRET_NAME_RE.test(key.slice(prefix.length));
}

/**
 * Turns a secret REFERENCE into the secret.
 *
 * `eta_tenant_config` and `eta_pos_credentials` store `*Ref` columns, never
 * secret values: the rows are read by ordinary application code and land in
 * backups, `pg_dump`s and screen-shares, and an ETA client secret in any of
 * those is a taxpayer's fiscal identity handed over. The reference names where
 * the secret lives; only this function ever holds the value.
 *
 * Two spellings are accepted, matching `src/server/whatsapp/secrets.ts`'s
 * `resolveToken`: `env://ETA_ACME__CLIENT_SECRET` and the bare key. Both
 * resolve against `process.env` — and only inside the tenant's own namespace
 * (see `etaSecretKeyPrefix`): a ref naming anything else is refused BEFORE the
 * environment is read. The env-backed implementation is the local/dev/deploy
 * path; pointing this at a real secret manager is a change to this one
 * function.
 *
 * A ref that is PRESENT but unresolvable is an `EtaConfigError`, never a
 * silent `null` secret: a config row that says "my secret is in
 * ETA_ACME__CLIENT_SECRET" while that variable is unset is a broken deployment,
 * and the failure that says so is worth vastly more than a token request that
 * comes back `invalid_clientsecret` an hour later.
 *
 * The thrown message names the ENV KEY, which is not itself a secret, and
 * never the value.
 */
function resolveSecretRef(ref: string, column: string, tenantSlug: string): string {
  const key = refKey(ref);
  if (!isTenantBoundSecretRef(ref, tenantSlug)) {
    throw new EtaConfigError(
      "secret-ref-out-of-namespace",
      `fiscal: ${column} names an env key outside this tenant's namespace — ETA credential refs must have the form ` +
        `${etaSecretRefPrefix(tenantSlug)}<NAME>. It was not read. Re-save the credential under that prefix.`,
    );
  }
  const value = process.env[key];
  if (!value) {
    throw new EtaConfigError(
      "missing-secret-ref",
      `fiscal: ${column} points at env key ${key}, which is unset or empty — ` +
        "the ETA credential cannot be assembled. Set it in the deployment's environment.",
    );
  }
  return value;
}

/** `resolveSecretRef` for a nullable ref column: null in, null out. A ref that
 *  IS set still has to resolve. */
function resolveOptionalSecretRef(ref: string | null, column: string, tenantSlug: string): string | null {
  return ref === null ? null : resolveSecretRef(ref, column, tenantSlug);
}

/**
 * The `EtaConfig.signingKey` thunk for a stored `signing_key_ref`.
 *
 * Exported because `./finalize` needs the SAME thunk without assembling a whole
 * `EtaConfig`: an invoice's `documentTypeVersion` is decided at finalization
 * (it is part of the document's own signed bytes), so the finalizer has to know
 * whether a signer exists — but it has no business resolving a device
 * credential or an ERP secret to find out. Both callers therefore share this
 * one definition rather than spelling the column name twice.
 *
 * Lazy for the reason `EtaConfig.signingKey` documents at length: nothing on
 * the receipt path reads it, so resolving eagerly let a stale B2B ref take a
 * tenant's RECEIPTS down with it.
 */
export function signingKeyThunk(signingKeyRef: string | null, tenantSlug: string): () => string | null {
  return () => resolveOptionalSecretRef(signingKeyRef, "eta_tenant_config.signing_key_ref", tenantSlug);
}

/** The tenant's slug — the root of its secret-ref namespace. `tenants` is a
 *  control table (no RLS), readable on any tenant-scoped transaction. */
export async function loadTenantSlug(tx: Tx, tenantId: string): Promise<string> {
  const [tenant] = await tx.select({ slug: tenants.slug }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new EtaConfigError("tenant-missing", `fiscal: tenant ${tenantId} does not exist`);
  return tenant.slug;
}

/**
 * The tenant's (and optionally the device's) live ETA credentials, or `null`
 * when this tenant/device is not in a state to talk to ETA at all.
 *
 * WHAT `null` MEANS. Not an error, and not "try again later" — it is the
 * documented, expected answer for a tenant that has not finished ETA
 * onboarding. Callers should skip submission entirely, exactly as
 * `NoopFiscalProvider` does for a non-EG tenant. Three cases return it:
 *
 *   1. No `eta_tenant_config` row.
 *   2. `activationStatus !== "active"` — i.e. `not_configured`, `pending`
 *      (credentials captured, ETA has not activated the taxpayer yet) or
 *      `suspended` (activation withdrawn). Submitting under any of those is a
 *      guaranteed refusal.
 *   3. `deviceId` was given and that device has no usable credential (below).
 *
 * WHY `deviceId` DECIDES THE CREDENTIAL. E-receipts are submitted with the
 * POS device's own ETA identity, not the ERP one — `eta_tenant_config`'s
 * JSDoc says as much, and the Authenticate POS API is a different call with
 * different headers. Pass `deviceId` for the receipt path; omit it for the
 * ERP-level paths (B2B `e_invoice`, the codes APIs), where `device` comes back
 * `null` and the provider uses the ERP login.
 *
 * WHICH DEVICE STATUSES ARE USABLE — `"active"` ONLY. The
 * `eta_pos_credential_status` enum is `registered | active | expired |
 * retired`. Submit Receipt Documents states "Note! POS should be activated
 * before submission on any other channel", so `registered` (provisioned at
 * ETA, activation not yet completed) is not usable; `expired` and `retired`
 * are self-evidently not. Being strict here converts a whole class of "ETA
 * rejected everything for a week" into a visible, skipped-submission state.
 * `expiresAt` is deliberately NOT re-checked against the clock: the row's
 * `status` is the authority, and a background job moving `active` → `expired`
 * is the single place that transition should happen.
 *
 * VALIDATION IS NOT THIS FUNCTION'S JOB. Shape rules — the 9-digit RIN Main
 * Calculations requires, the decimal shape of a buyer-identification
 * threshold, a serial within ETA's 100 characters — belong to Task 6's config
 * service, which runs them ONCE at config-save time with the operator in front
 * of it. `resolveEtaConfig` trusts the stored rows and only reports what it
 * cannot assemble at all. Re-validating on every submission would move a
 * fixable data-entry mistake into the fiscal hot path, where it can only be
 * reported as a failed receipt.
 *
 * SECRETS. Resolved values live in the returned object and nowhere else: they
 * are never written back to the database, never logged, and must never be put
 * on an HTTP response or a `responseJson`. Every caller is expected to keep
 * `EtaConfig` inside the server.
 *
 * @throws {EtaConfigError} when a `*Ref` column needed by the requested path is
 * set but its env key is not. Only the DEVICE secrets resolve eagerly, so only
 * they throw from this call — and they are the ones the receipt path actually
 * uses, so a failure there is a failure that matters. `erp.clientSecret` and
 * `signingKey` are THUNKS that resolve when called instead: both are B2B-only
 * credentials, and neither may take the receipt path down with it.
 */
export async function resolveEtaConfig(tenantId: string, deviceId?: string): Promise<EtaConfig | null> {
  const rows = await withTenant(tenantId, async (tx) => {
    const tenantSlug = await loadTenantSlug(tx, tenantId);
    const [tenantRow] = await tx
      .select()
      .from(etaTenantConfig)
      .where(eq(etaTenantConfig.tenantId, tenantId))
      .limit(1);

    // Short-circuit before the second query: an inactive tenant has no ETA
    // path at all, so its device credentials are irrelevant.
    if (!tenantRow || tenantRow.activationStatus !== "active") return { tenantSlug, tenantRow: null, deviceRow: null };
    if (!deviceId) return { tenantSlug, tenantRow, deviceRow: null };

    const [deviceRow] = await tx
      .select()
      .from(etaPosCredentials)
      .where(and(eq(etaPosCredentials.tenantId, tenantId), eq(etaPosCredentials.deviceId, deviceId)))
      .limit(1);

    return { tenantSlug, tenantRow, deviceRow: deviceRow ?? null };
  });

  const { tenantSlug, tenantRow, deviceRow } = rows;
  if (!tenantRow) return null;
  if (deviceId && (!deviceRow || deviceRow.status !== "active")) return null;

  const device: EtaDeviceCredentials | null = deviceRow
    ? {
        serial: deviceRow.etaSerial,
        clientId: deviceRow.clientId,
        secret1: resolveSecretRef(deviceRow.clientSecret1Ref, "eta_pos_credentials.client_secret_1_ref", tenantSlug),
        secret2: resolveSecretRef(deviceRow.clientSecret2Ref, "eta_pos_credentials.client_secret_2_ref", tenantSlug),
        // Nullable by design: how the ETA portal provisions a device's
        // pre-shared key is not publicly documented (see the column's JSDoc).
        // The provider decides what an absent key means at token time — it is
        // not this function's call to make.
        presharedKey: resolveOptionalSecretRef(deviceRow.presharedKeyRef, "eta_pos_credentials.preshared_key_ref", tenantSlug),
        osVersion: deviceRow.posOsVersion,
        modelFramework: deviceRow.posModelFramework,
      }
    : null;

  const clientSecretRef = tenantRow.clientSecretRef;
  const signingKeyRef = tenantRow.signingKeyRef;

  return {
    // ETA calls it the Registration Identification Number; the column predates
    // that spelling. This is the only place the two names are bridged.
    rin: tenantRow.registrationNumber,
    environment: tenantRow.environment,
    erp: {
      clientId: tenantRow.clientId,
      /**
       * RESOLVED LAZILY, when CALLED — the one deliberate exception to this
       * function's otherwise-eager resolution.
       *
       * The ERP secret is used by exactly one code path: the Login as Taxpayer
       * System call, which `EtaFiscalProvider` makes only when `device` is
       * null (B2B `e_invoice` and the codes APIs — deferred today). E-receipt
       * submission never touches it. Resolving it eagerly meant that a tenant
       * whose ERP secret ref had gone stale could not submit RECEIPTS either:
       * the whole resolution threw, naming a credential that the receipt path
       * does not use and cannot be fixed by anyone looking at the till. That
       * is an availability fault on the fiscal hot path caused by an unrelated,
       * unused credential. Deferring keeps the failure where it belongs — at
       * the ERP login that needs the secret — and the error still names this
       * precise column and env key when it fires.
       *
       * A THUNK rather than a getter, deliberately: `() => string` is visible
       * at the call site, so nobody is surprised by a property read throwing,
       * and `JSON.stringify` DROPS a function value outright instead of
       * invoking it. The secret is not memoised and is not held in memory
       * until something asks for it. As with every other field here, the
       * resolved value must never be logged, persisted or returned to a
       * client.
       */
      clientSecret: () => resolveSecretRef(clientSecretRef, "eta_tenant_config.client_secret_ref", tenantSlug),
    },
    device,
    /**
     * RESOLVED LAZILY, for the same reason as `erp.clientSecret` above and with
     * a sharper edge. The e-seal signs B2B e_invoices; ETA has not deployed
     * receipt batch-signature validation at all (addendum C7), so NO receipt
     * path reads this. Resolving it eagerly meant a stale `signing_key_ref`
     * threw out of this whole function — and the submission worker classifies
     * `EtaConfigError` as PERMANENT, so one unset env var for an unused
     * credential would have failed every receipt the tenant ever issued,
     * terminally, with an alert naming something no receipt needs.
     *
     * `null` (no signing material configured) stays a value, not a throw: it is
     * the ordinary state of a receipt-only tenant.
     */
    signingKey: signingKeyThunk(signingKeyRef, tenantSlug),
  };
}
