import { eq, and } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import { etaTenantConfig, etaPosCredentials } from "./schema";
import { EtaConfigError } from "./eta-transport-errors";
import type { EtaConfig, EtaDeviceCredentials } from "./provider";

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
 * `resolveToken`: `env://ETA_SECRET_ACME` and the bare `ETA_SECRET_ACME`. Both
 * resolve against `process.env`. The env-backed implementation is the
 * local/dev/deploy path; pointing this at a real secret manager is a change to
 * this one function.
 *
 * A ref that is PRESENT but unresolvable is an `EtaConfigError`, never a
 * silent `null` secret: a config row that says "my secret is in
 * ETA_SECRET_ACME" while that variable is unset is a broken deployment, and
 * the failure that says so is worth vastly more than a token request that
 * comes back `invalid_clientsecret` an hour later.
 *
 * The thrown message names the ENV KEY, which is not itself a secret, and
 * never the value.
 */
function resolveSecretRef(ref: string, column: string): string {
  const key = ref.startsWith("env://") ? ref.slice("env://".length) : ref;
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
function resolveOptionalSecretRef(ref: string | null, column: string): string | null {
  return ref === null ? null : resolveSecretRef(ref, column);
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
 * set but its env key is not. The tenant signing key and the device secrets
 * resolve eagerly, so they throw from this call; `erp.clientSecret` resolves on
 * first read instead — see its own comment for why.
 */
export async function resolveEtaConfig(tenantId: string, deviceId?: string): Promise<EtaConfig | null> {
  const rows = await withTenant(tenantId, async (tx) => {
    const [tenantRow] = await tx
      .select()
      .from(etaTenantConfig)
      .where(eq(etaTenantConfig.tenantId, tenantId))
      .limit(1);

    // Short-circuit before the second query: an inactive tenant has no ETA
    // path at all, so its device credentials are irrelevant.
    if (!tenantRow || tenantRow.activationStatus !== "active") return { tenantRow: null, deviceRow: null };
    if (!deviceId) return { tenantRow, deviceRow: null };

    const [deviceRow] = await tx
      .select()
      .from(etaPosCredentials)
      .where(and(eq(etaPosCredentials.tenantId, tenantId), eq(etaPosCredentials.deviceId, deviceId)))
      .limit(1);

    return { tenantRow, deviceRow: deviceRow ?? null };
  });

  const { tenantRow, deviceRow } = rows;
  if (!tenantRow) return null;
  if (deviceId && (!deviceRow || deviceRow.status !== "active")) return null;

  const device: EtaDeviceCredentials | null = deviceRow
    ? {
        serial: deviceRow.etaSerial,
        clientId: deviceRow.clientId,
        secret1: resolveSecretRef(deviceRow.clientSecret1Ref, "eta_pos_credentials.client_secret_1_ref"),
        secret2: resolveSecretRef(deviceRow.clientSecret2Ref, "eta_pos_credentials.client_secret_2_ref"),
        // Nullable by design: how the ETA portal provisions a device's
        // pre-shared key is not publicly documented (see the column's JSDoc).
        // The provider decides what an absent key means at token time — it is
        // not this function's call to make.
        presharedKey: resolveOptionalSecretRef(deviceRow.presharedKeyRef, "eta_pos_credentials.preshared_key_ref"),
        osVersion: deviceRow.posOsVersion,
        modelFramework: deviceRow.posModelFramework,
      }
    : null;

  const clientSecretRef = tenantRow.clientSecretRef;

  return {
    // ETA calls it the Registration Identification Number; the column predates
    // that spelling. This is the only place the two names are bridged.
    rin: tenantRow.registrationNumber,
    environment: tenantRow.environment,
    erp: {
      clientId: tenantRow.clientId,
      /**
       * RESOLVED LAZILY, on first read — the one deliberate exception to this
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
       * unused credential.
       *
       * Deferring it keeps the failure exactly where it belongs — at the ERP
       * login that needs the secret — while the error, when it does fire,
       * still names this precise column and env key. The property type is
       * unchanged, so `EtaConfig` is untouched.
       *
       * The value is therefore NOT memoised and NOT held in memory until
       * something asks for it. As with every other field here, it must never
       * be logged, serialised or returned to a client — and note that reading
       * it (including by spreading or inspecting `erp`) is what triggers
       * resolution, which is another reason an `EtaConfig` must never be
       * passed to `JSON.stringify`.
       */
      get clientSecret(): string {
        return resolveSecretRef(clientSecretRef, "eta_tenant_config.client_secret_ref");
      },
    },
    device,
    signingKey: resolveOptionalSecretRef(tenantRow.signingKeyRef, "eta_tenant_config.signing_key_ref"),
  };
}
