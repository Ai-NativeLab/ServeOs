import QRCode from "qrcode";
/**
 * The ONLY zod import in the repository (house convention elsewhere is
 * hand-rolled validators), and a declared runtime dependency as of this task —
 * it was previously a dev-only transitive of `eslint-plugin-react-hooks`, which
 * app code must not import from. Declaring it also bumped 4.4.3 → 4.5.4; see
 * §6 of `docs/ailab/specs/2026-08-30-eta-verified-findings-addendum.md`.
 *
 * ONE EDGE CROSSES A MODULE BOUNDARY. `UpdateFiscalConfigInput` and
 * `UpsertDeviceCredentialInput` are `z.input<typeof …>`, and the dashboard
 * routes import those types to shape their request bodies. The types ERASE at
 * compile time, so nothing zod-shaped reaches the bundle or the wire — but a
 * zod MAJOR bump that changes inference can break `tsc` in
 * `api/dashboard/fiscal/**` rather than here, which is a confusing place to
 * discover it. The runtime values (`FiscalConfigInputError`, its `issues`) are
 * this module's own, precisely so no route ever catches a `ZodError`.
 */
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/db/with-tenant";
import { posDevices } from "@/server/pos/schema";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import {
  etaTenantConfig,
  etaPosCredentials,
  etaSubmissions,
  etaEnvironmentEnum,
  etaActivationStatusEnum,
  etaCodeSourceEnum,
  etaPosCredentialStatusEnum,
  type EtaWireContextConfig,
  type EtaEnvironment,
  type EtaActivationStatus,
  type EtaPosCredentialStatus,
  type EtaDocType,
  type EtaSubmissionStatus,
} from "./schema";

/**
 * The fiscal CONFIGURATION surface: everything an owner sets up once, read back
 * masked, plus the per-order status the POS reads and the submission feed the
 * dashboard lists. Gated by `fiscal:manage` (owner only) at every entry point
 * above this module.
 *
 * TWO RULES SHAPE THIS WHOLE FILE.
 *
 * 1. THIS MODULE OWNS SAVE-TIME VALIDATION. `resolveEtaConfig` (./config) and
 *    `requireWireContext` (./finalize) deliberately only presence-check what
 *    they read: re-validating shape on the fiscal hot path would turn a fixable
 *    data-entry mistake into a failed receipt reported hours later. So the 9-digit
 *    RIN, the 100-character ETA serial and the decimal shape of a buyer-id
 *    threshold are checked HERE, once, with the operator in front of the form.
 *    The mandatory wire-context set below mirrors `requireWireContext` exactly —
 *    if the two ever diverge, this module accepts a config the worker will refuse.
 *
 * 2. NOTHING HERE EVER RETURNS A `*Ref` VALUE. The `client_secret_ref`,
 *    `signing_key_ref`, `client_secret_1_ref`, `client_secret_2_ref` and
 *    `preshared_key_ref` columns name where a credential lives; they are
 *    WRITE-ONLY through this service. Every read returns a `has…` boolean
 *    instead, and the audit metadata records which FIELDS changed, never their
 *    values. A ref is not itself a secret, but echoing one hands an attacker the
 *    map to the secret store — and the masking guarantee is much easier to keep
 *    honest as "no ref ever leaves" than as a per-field judgement call.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A save refused because the input is not a valid ETA configuration.
 *
 * One error class for BOTH Zod shape failures and the cross-field checks Zod
 * cannot express (an `onlineDeviceId` that is not this tenant's device, an
 * illegal credential status transition, a required ref missing on first save),
 * so a route has exactly one thing to map to a 400 and `zod` never has to be
 * imported at the HTTP layer.
 *
 * `issues` carries a dotted field path per problem so a form can put the
 * message next to the input that caused it.
 */
export class FiscalConfigInputError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; "));
    this.name = "FiscalConfigInputError";
  }
}

function fail(path: string, message: string): never {
  throw new FiscalConfigInputError([{ path, message }]);
}

/** Runs a schema and re-throws a `ZodError` as this module's one input error. */
function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new FiscalConfigInputError(
    result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

/** ETA's Registration Identification Number: exactly 9 digits (Main
 *  Calculations). Anything else is refused rather than filed. */
const rinSchema = z.string().trim().regex(/^\d{9}$/, "must be exactly 9 digits — ETA's Registration Identification Number");

/** The serial the device is registered under at pos.eta.gov.eg. ETA caps it at
 *  100 characters, and it is part of every hashed receipt that device issues. */
const etaSerialSchema = z.string().trim().min(1, "is required").max(100, "must be at most 100 characters — ETA's cap on the POS serial");

/**
 * A plain decimal amount. Deliberately the shape `assertDecimal` (./decimal)
 * accepts MINUS the sign: `compareDecimal` asserts this shape at document-build
 * time, so an amount that fails here would fail there instead — permanently, on
 * a receipt already handed to a customer. A negative threshold is refused
 * outright: it would identify every buyer, which is not a configuration anyone
 * means to make.
 */
const decimalSchema = z.string().trim().regex(/^\d+(\.\d+)?$/, "must be a plain decimal amount such as 150000.00 — no sign, no exponent");

const requiredText = (what: string) => z.string().trim().min(1, `${what} is required`);

/** Fiscal classification for one fee line — mirrors `EtaFeeLineConfig`
 *  (./schema) / `FeeLineConfig` (./provider) field for field. */
const feeLineSchema = z.object({
  itemCode: requiredText("an item code"),
  codeSource: z.enum(etaCodeSourceEnum.enumValues),
  taxType: requiredText("a tax type"),
  // Nullable, not optional: `EtaFeeLineConfig.taxSubType` is `string | null`,
  // and a fee whose tax genuinely has no sub-type must be able to say so.
  taxSubType: z.string().trim().min(1).nullable(),
  unitType: requiredText("a unit type"),
  description: requiredText("a description"),
  internalCode: requiredText("an internal code"),
});

/**
 * The stored half of receipt v1.2's seller block.
 *
 * The MANDATORY set — `sellerName`, `activityCode`, `branchCode` and the five
 * structured `branchAddress` fields — is exactly `requireWireContext`'s
 * (./finalize). That function refuses to emit a document it could only build by
 * inventing seller identity; this schema refuses to STORE one, so the refusal
 * lands on the operator's form instead of on a customer's receipt.
 *
 * Every remaining field is optional because ETA marks it optional, and each is
 * carried through verbatim: dropping `postalCode` here would mean the dashboard
 * could never set it, and a field the form cannot set is a field the tenant
 * cannot comply with.
 */
const wireContextSchema = z.object({
  sellerName: requiredText("the seller's trade name"),
  activityCode: requiredText("an ETA activity code"),
  branchCode: requiredText("the branch code registered with ETA"),
  branchAddress: z.object({
    country: requiredText("a country code"),
    governate: requiredText("a governate"),
    regionCity: requiredText("a region/city"),
    street: requiredText("a street"),
    buildingNumber: requiredText("a building number"),
    postalCode: z.string().trim().optional(),
    floor: z.string().trim().optional(),
    room: z.string().trim().optional(),
    landmark: z.string().trim().optional(),
    additionalInformation: z.string().trim().optional(),
  }),
  syndicateLicenseNumber: z.string().trim().optional(),
  feeLines: z
    .object({ serviceCharge: feeLineSchema.optional(), delivery: feeLineSchema.optional() })
    .optional(),
  buyerIdThreshold: decimalSchema.optional(),
});

/**
 * A `*Ref` input: the env key (or `env://KEY`) the credential lives behind —
 * never the credential. Optional on every update so the owner can change the
 * RIN or the environment without re-typing a reference the form cannot show
 * them; `undefined` means "leave whatever is stored", and the required-on-create
 * check below is what stops a first save from landing without one.
 */
const refSchema = z.string().trim().min(1, "must name the environment key holding the credential, e.g. ETA_CLIENT_SECRET_ACME");

const updateConfigSchema = z.object({
  rin: rinSchema,
  clientId: requiredText("the ERP client id"),
  clientSecretRef: refSchema.optional(),
  // Nullable AND optional, and the two mean different things: `null` clears the
  // e-seal reference (the ordinary state of a receipt-only tenant), `undefined`
  // leaves it untouched.
  signingKeyRef: refSchema.nullable().optional(),
  environment: z.enum(etaEnvironmentEnum.enumValues),
  activationStatus: z.enum(etaActivationStatusEnum.enumValues),
  onlineDeviceId: z.uuid("must be a POS device id").nullable().optional(),
  wireContext: wireContextSchema.nullable().optional(),
});

export type UpdateFiscalConfigInput = z.input<typeof updateConfigSchema>;

const upsertDeviceCredentialSchema = z.object({
  etaSerial: etaSerialSchema,
  clientId: requiredText("the device client id"),
  clientSecret1Ref: refSchema.optional(),
  clientSecret2Ref: refSchema.optional(),
  presharedKeyRef: refSchema.nullable().optional(),
  posOsVersion: z.string().trim().min(1).nullable().optional(),
  posModelFramework: z.string().trim().min(1).nullable().optional(),
  status: z.enum(etaPosCredentialStatusEnum.enumValues).optional(),
});

export type UpsertDeviceCredentialInput = z.input<typeof upsertDeviceCredentialSchema>;

// ---------------------------------------------------------------------------
// Masked read shapes
// ---------------------------------------------------------------------------

export type FiscalConfigView = {
  rin: string;
  clientId: string;
  environment: EtaEnvironment;
  activationStatus: EtaActivationStatus;
  onlineDeviceId: string | null;
  /** Whether a reference is stored — NOT the reference, and never the secret. */
  hasSecret: boolean;
  hasSigningKey: boolean;
  /**
   * The seller block itself, which holds no credential of any kind: a trade
   * name, an activity code and a branch address, all of which are printed on
   * every receipt the tenant issues. Returned so the config form can show what
   * is stored instead of making the owner retype eleven fields to change one.
   */
  wireContext: EtaWireContextConfig | null;
  /** True when the stored wire context would satisfy `requireWireContext`. */
  wireContextConfigured: boolean;
  /** The mandatory wire-context fields still missing, dotted (e.g.
   *  `branchAddress.governate`) — the same names `requireWireContext` reports,
   *  so the dashboard and the failed submission agree on what to fix. */
  wireContextMissing: string[];
};

export type DeviceCredentialView = {
  deviceId: string;
  /** The POS device's own label, so the dashboard names a till rather than a
   *  uuid. Null when the credential outlives the device row it points at. */
  deviceLabel: string | null;
  etaSerial: string;
  clientId: string;
  hasSecret1: boolean;
  hasSecret2: boolean;
  hasPresharedKey: boolean;
  posOsVersion: string | null;
  posModelFramework: string | null;
  status: EtaPosCredentialStatus;
  activatedAt: Date | null;
  expiresAt: Date | null;
};

export type SaleFiscalStatus = {
  status: EtaSubmissionStatus;
  etaUuid: string | null;
  qrPayload: string | null;
  /** A PNG data URL rendered from the STORED `qrPayload`. Never recomputed
   *  from the document: `./finalize` persists the payload as part of the
   *  receipt's fiscal identity, and re-deriving it here could print a QR that
   *  disagrees with the one already hashed into the uuid. */
  qrImageDataUrl: string | null;
};

export type SubmissionRowView = {
  id: string;
  docType: EtaDocType;
  orderId: string | null;
  refundId: string | null;
  status: EtaSubmissionStatus;
  etaUuid: string | null;
  attempts: number;
  lastError: string | null;
  referenceOldUuid: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
};

// ---------------------------------------------------------------------------
// Tenant config
// ---------------------------------------------------------------------------

/** The mandatory wire-context field names, in `requireWireContext`'s own order
 *  and spelling. Kept as data so `getFiscalConfig` can REPORT what is missing
 *  while `finalize` THROWS on it — one list, two consumers. */
function missingWireContextFields(value: EtaWireContextConfig | null): string[] {
  if (!value) return ["sellerName", "activityCode", "branchCode", "branchAddress"];
  const missing: string[] = [];
  for (const key of ["sellerName", "activityCode", "branchCode"] as const) {
    if (!value[key]) missing.push(key);
  }
  const address = value.branchAddress;
  if (!address) missing.push("branchAddress");
  else {
    for (const key of ["country", "governate", "regionCity", "street", "buildingNumber"] as const) {
      if (!address[key]) missing.push(`branchAddress.${key}`);
    }
  }
  return missing;
}

function toConfigView(row: typeof etaTenantConfig.$inferSelect): FiscalConfigView {
  const missing = missingWireContextFields(row.wireContextJson);
  return {
    // The column is `registration_number`; ETA calls it the RIN. The same
    // bridge `resolveEtaConfig` makes, made once more at the read surface.
    rin: row.registrationNumber,
    clientId: row.clientId,
    environment: row.environment,
    activationStatus: row.activationStatus,
    onlineDeviceId: row.onlineDeviceId,
    // Booleans, deliberately: `row.clientSecretRef` must not cross this line.
    hasSecret: Boolean(row.clientSecretRef),
    hasSigningKey: Boolean(row.signingKeyRef),
    wireContext: row.wireContextJson,
    wireContextConfigured: missing.length === 0,
    wireContextMissing: missing,
  };
}

/** The tenant's ETA configuration, masked, or `null` when setup has not
 *  started. Safe to hand to a `fiscal:manage` holder as-is. */
export async function getFiscalConfig(tenantId: string): Promise<FiscalConfigView | null> {
  const row = await withTenant(tenantId, (tx) => loadConfigRow(tx, tenantId));
  return row ? toConfigView(row) : null;
}

function loadConfigRow(tx: Tx, tenantId: string) {
  return tx
    .select()
    .from(etaTenantConfig)
    .where(eq(etaTenantConfig.tenantId, tenantId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Confirms `deviceId` is one of THIS tenant's POS devices.
 *
 * `eta_tenant_config.online_device_id` is an FK to `pos_devices`, but
 * `pos_devices` is a control-plane table without RLS, so the constraint alone
 * would happily accept another tenant's device id — and that device would then
 * carry every deviceless online sale onto a foreign uuid chain under a foreign
 * ETA credential. The tenant predicate here is the actual control; the FK only
 * stops the id being fictional.
 */
async function assertOwnDevice(tx: Tx, tenantId: string, deviceId: string, path: string): Promise<void> {
  const [device] = await tx
    .select({ id: posDevices.id })
    .from(posDevices)
    .where(and(eq(posDevices.id, deviceId), eq(posDevices.tenantId, tenantId)))
    .limit(1);
  if (!device) fail(path, "is not one of this tenant's POS devices");
}

/**
 * Creates or updates the tenant's ETA configuration and audits the change.
 *
 * UPSERT, not insert-or-fail: `eta_tenant_config` is one row per tenant
 * (`eta_tenant_config_tenant`), so "save the form" is one operation whether or
 * not setup has been started.
 *
 * SECRET REFERENCES ARE WRITE-ONLY. Omitting `clientSecretRef` keeps the stored
 * one — the form cannot display it, so requiring it on every save would mean
 * retyping a credential pointer to change the environment dropdown, and a
 * mistyped pointer breaks submission for every receipt until someone notices.
 * On the FIRST save there is nothing to keep, so it is required then.
 *
 * @throws {FiscalConfigInputError} on any shape, cross-field or transition
 * problem — routes map exactly this to a 400.
 */
export async function updateFiscalConfig(
  tenantId: string,
  input: UpdateFiscalConfigInput,
  audit?: AuditActorInput,
): Promise<FiscalConfigView> {
  const parsed = parseOrThrow(updateConfigSchema, input);

  return withTenant(tenantId, async (tx) => {
    const existing = await loadConfigRow(tx, tenantId);

    const clientSecretRef = parsed.clientSecretRef ?? existing?.clientSecretRef;
    if (!clientSecretRef) {
      fail("clientSecretRef", "is required the first time ETA configuration is saved");
    }
    if (parsed.onlineDeviceId) {
      await assertOwnDevice(tx, tenantId, parsed.onlineDeviceId, "onlineDeviceId");
    }

    const wireContextJson: EtaWireContextConfig | null =
      parsed.wireContext === undefined ? existing?.wireContextJson ?? null : parsed.wireContext;
    const signingKeyRef =
      parsed.signingKeyRef === undefined ? existing?.signingKeyRef ?? null : parsed.signingKeyRef;
    const onlineDeviceId =
      parsed.onlineDeviceId === undefined ? existing?.onlineDeviceId ?? null : parsed.onlineDeviceId;

    const values = {
      tenantId,
      registrationNumber: parsed.rin,
      clientId: parsed.clientId,
      clientSecretRef,
      signingKeyRef,
      environment: parsed.environment,
      activationStatus: parsed.activationStatus,
      onlineDeviceId,
      wireContextJson,
    };

    const [row] = await tx
      .insert(etaTenantConfig)
      .values(values)
      .onConflictDoUpdate({
        target: etaTenantConfig.tenantId,
        set: {
          registrationNumber: values.registrationNumber,
          clientId: values.clientId,
          clientSecretRef: values.clientSecretRef,
          signingKeyRef: values.signingKeyRef,
          environment: values.environment,
          activationStatus: values.activationStatus,
          onlineDeviceId: values.onlineDeviceId,
          wireContextJson: values.wireContextJson,
        },
      })
      .returning();

    const view = toConfigView(row);
    await recordAuditEvent(
      auditContext(tenantId, audit),
      {
        action: "eta.config.updated",
        entityType: "eta_tenant_config",
        entityId: row.id,
        summary: existing ? "ETA configuration updated" : "ETA configuration created",
        // FIELD NAMES ONLY. `changedFields` may name `clientSecretRef`; it must
        // never carry its value — audit rows are readable by every audit:view
        // holder, which is a strictly wider audience than fiscal:manage.
        metadata: {
          created: !existing,
          changedFields: changedConfigFields(existing, row),
          environment: view.environment,
          activationStatus: view.activationStatus,
          hasSecret: view.hasSecret,
          hasSigningKey: view.hasSigningKey,
          wireContextConfigured: view.wireContextConfigured,
          roleKey: audit?.roleKey ?? null,
        },
        actorType: audit?.actorType ?? "user",
      },
      tx,
    );

    return view;
  });
}

/** Which columns this save actually changed, by NAME. `wireContextJson` is
 *  compared as serialized text — it is a whole nested block, and "the seller
 *  details changed" is the fact worth recording. */
function changedConfigFields(
  before: typeof etaTenantConfig.$inferSelect | null,
  after: typeof etaTenantConfig.$inferSelect,
): string[] {
  if (!before) return [];
  const changed: string[] = [];
  const scalars = [
    ["rin", "registrationNumber"],
    ["clientId", "clientId"],
    ["clientSecretRef", "clientSecretRef"],
    ["signingKeyRef", "signingKeyRef"],
    ["environment", "environment"],
    ["activationStatus", "activationStatus"],
    ["onlineDeviceId", "onlineDeviceId"],
  ] as const;
  for (const [label, column] of scalars) {
    if (before[column] !== after[column]) changed.push(label);
  }
  if (JSON.stringify(before.wireContextJson) !== JSON.stringify(after.wireContextJson)) {
    changed.push("wireContext");
  }
  return changed;
}

/** The audit context a dashboard actor supplies, with the same
 *  `emptyFingerprint()` fallback every other service in the house uses when a
 *  caller has no request headers to fingerprint (seeds, tests, scripts). */
function auditContext(tenantId: string, audit?: AuditActorInput) {
  return {
    tenantId,
    actorUserId: audit?.actorUserId ?? null,
    fingerprint: audit?.fingerprint ?? emptyFingerprint(),
  };
}

// ---------------------------------------------------------------------------
// Device credentials
// ---------------------------------------------------------------------------

function toCredentialView(
  row: typeof etaPosCredentials.$inferSelect,
  deviceLabel: string | null,
): DeviceCredentialView {
  return {
    deviceId: row.deviceId,
    deviceLabel,
    etaSerial: row.etaSerial,
    clientId: row.clientId,
    // Three booleans where three refs are stored — see this file's rule 2.
    hasSecret1: Boolean(row.clientSecret1Ref),
    hasSecret2: Boolean(row.clientSecret2Ref),
    hasPresharedKey: Boolean(row.presharedKeyRef),
    posOsVersion: row.posOsVersion,
    posModelFramework: row.posModelFramework,
    status: row.status,
    activatedAt: row.activatedAt,
    expiresAt: row.expiresAt,
  };
}

/** Every ETA device credential this tenant holds, masked, newest device first. */
export async function listDeviceCredentials(tenantId: string): Promise<DeviceCredentialView[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ credential: etaPosCredentials, deviceLabel: posDevices.label })
      .from(etaPosCredentials)
      .leftJoin(
        posDevices,
        and(eq(posDevices.id, etaPosCredentials.deviceId), eq(posDevices.tenantId, tenantId)),
      )
      .where(eq(etaPosCredentials.tenantId, tenantId))
      .orderBy(desc(etaPosCredentials.createdAt));
    return rows.map((r) => toCredentialView(r.credential, r.deviceLabel));
  });
}

/** One device's masked credential, or `null` when it has none. */
export async function getDeviceCredential(
  tenantId: string,
  deviceId: string,
): Promise<DeviceCredentialView | null> {
  const all = await listDeviceCredentials(tenantId);
  return all.find((c) => c.deviceId === deviceId) ?? null;
}

/**
 * Which credential statuses may follow which.
 *
 * `eta_pos_credential_status` is `registered | active | expired | retired`, and
 * `resolveEtaConfig` submits under `active` ONLY. So the transitions are the
 * ones a real device goes through:
 *
 *   registered → active   ETA completed activation for this POS
 *   active     → expired  the credential aged out (also written by a job)
 *   expired    → active   renewed at pos.eta.gov.eg and re-recorded
 *   *          → retired  the till is gone; TERMINAL
 *
 * `retired` is terminal on purpose. `eta_device_chains` keys the receipt uuid
 * chain on the device, and re-activating a retired credential is how a till
 * comes back with the same serial and a chain someone believes is finished.
 * Registering a replacement device is the supported move.
 */
const CREDENTIAL_TRANSITIONS: Record<EtaPosCredentialStatus, EtaPosCredentialStatus[]> = {
  registered: ["registered", "active", "retired"],
  active: ["active", "expired", "retired"],
  expired: ["expired", "active", "retired"],
  retired: ["retired"],
};

/** A brand-new credential row may only start where a real one starts: recorded
 *  at ETA (`registered`) or already activated by them (`active`). */
const CREDENTIAL_INITIAL_STATUSES: EtaPosCredentialStatus[] = ["registered", "active"];

/**
 * Creates or updates one POS device's ETA credential and audits the change.
 *
 * Same write-only rule as `updateFiscalConfig`: `clientSecret1Ref` /
 * `clientSecret2Ref` are required on first save and optional thereafter, so
 * recording an activation does not mean retyping two credential pointers.
 *
 * `activatedAt` is stamped by this function on the transition INTO `active`
 * rather than accepted from the caller — it is the record of when this system
 * began submitting under the credential, which a form field could only get
 * wrong.
 *
 * @throws {FiscalConfigInputError} for an unknown device, a missing ref on
 * first save, or a status transition the table above does not allow.
 */
export async function upsertDeviceCredential(
  tenantId: string,
  deviceId: string,
  input: UpsertDeviceCredentialInput,
  audit?: AuditActorInput,
): Promise<DeviceCredentialView> {
  const parsed = parseOrThrow(upsertDeviceCredentialSchema, input);
  if (!z.uuid().safeParse(deviceId).success) fail("deviceId", "must be a POS device id");

  return withTenant(tenantId, async (tx) => {
    await assertOwnDevice(tx, tenantId, deviceId, "deviceId");

    const [existing] = await tx
      .select()
      .from(etaPosCredentials)
      .where(and(eq(etaPosCredentials.tenantId, tenantId), eq(etaPosCredentials.deviceId, deviceId)))
      .limit(1);

    const clientSecret1Ref = parsed.clientSecret1Ref ?? existing?.clientSecret1Ref;
    const clientSecret2Ref = parsed.clientSecret2Ref ?? existing?.clientSecret2Ref;
    if (!clientSecret1Ref) fail("clientSecret1Ref", "is required the first time this device's credential is saved");
    if (!clientSecret2Ref) fail("clientSecret2Ref", "is required the first time this device's credential is saved");

    const previousStatus = existing?.status ?? null;
    const status = resolveCredentialStatus(previousStatus, parsed.status);

    const presharedKeyRef =
      parsed.presharedKeyRef === undefined ? existing?.presharedKeyRef ?? null : parsed.presharedKeyRef;
    const posOsVersion =
      parsed.posOsVersion === undefined ? existing?.posOsVersion ?? null : parsed.posOsVersion;
    const posModelFramework =
      parsed.posModelFramework === undefined ? existing?.posModelFramework ?? null : parsed.posModelFramework;
    // Stamped once, on the way in: a credential that was already active keeps
    // the timestamp it earned.
    const activatedAt =
      status === "active" ? existing?.activatedAt ?? new Date() : existing?.activatedAt ?? null;

    const [row] = await tx
      .insert(etaPosCredentials)
      .values({
        tenantId,
        deviceId,
        etaSerial: parsed.etaSerial,
        clientId: parsed.clientId,
        clientSecret1Ref,
        clientSecret2Ref,
        presharedKeyRef,
        posOsVersion,
        posModelFramework,
        status,
        activatedAt,
      })
      .onConflictDoUpdate({
        target: [etaPosCredentials.tenantId, etaPosCredentials.deviceId],
        set: {
          etaSerial: parsed.etaSerial,
          clientId: parsed.clientId,
          clientSecret1Ref,
          clientSecret2Ref,
          presharedKeyRef,
          posOsVersion,
          posModelFramework,
          status,
          activatedAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    const [device] = await tx
      .select({ label: posDevices.label })
      .from(posDevices)
      .where(and(eq(posDevices.id, deviceId), eq(posDevices.tenantId, tenantId)))
      .limit(1);

    await recordAuditEvent(
      auditContext(tenantId, audit),
      {
        action: "eta.device_credentials.updated",
        entityType: "eta_pos_credential",
        entityId: row.id,
        summary: existing
          ? `ETA credential updated for device ${device?.label ?? deviceId}`
          : `ETA credential recorded for device ${device?.label ?? deviceId}`,
        // Field names and lifecycle state only — no ref value, same rule as
        // eta.config.updated above.
        metadata: {
          deviceId,
          created: !existing,
          previousStatus,
          status,
          changedFields: changedCredentialFields(existing ?? null, row),
          hasSecret1: Boolean(row.clientSecret1Ref),
          hasSecret2: Boolean(row.clientSecret2Ref),
          hasPresharedKey: Boolean(row.presharedKeyRef),
          roleKey: audit?.roleKey ?? null,
        },
        actorType: audit?.actorType ?? "user",
      },
      tx,
    );

    return toCredentialView(row, device?.label ?? null);
  });
}

function resolveCredentialStatus(
  previous: EtaPosCredentialStatus | null,
  requested: EtaPosCredentialStatus | undefined,
): EtaPosCredentialStatus {
  if (previous === null) {
    // The column defaults to `registered`; saying so explicitly keeps the
    // create path and the transition table telling the same story.
    const next = requested ?? "registered";
    if (!CREDENTIAL_INITIAL_STATUSES.includes(next)) {
      fail("status", `cannot start at ${next} — a new credential is either registered or active`);
    }
    return next;
  }
  const next = requested ?? previous;
  if (!CREDENTIAL_TRANSITIONS[previous].includes(next)) {
    fail("status", `cannot move from ${previous} to ${next}`);
  }
  return next;
}

function changedCredentialFields(
  before: typeof etaPosCredentials.$inferSelect | null,
  after: typeof etaPosCredentials.$inferSelect,
): string[] {
  if (!before) return [];
  const columns = [
    "etaSerial",
    "clientId",
    "clientSecret1Ref",
    "clientSecret2Ref",
    "presharedKeyRef",
    "posOsVersion",
    "posModelFramework",
    "status",
  ] as const;
  return columns.filter((column) => before[column] !== after[column]);
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

/**
 * The fiscal state of one sale, for the POS receipt (Task 7).
 *
 * `null` means this order has no e-receipt row at all — a non-EG tenant, or a
 * sale whose enqueue has not landed yet. The POS renders no fiscal footer for
 * it, which is the country-gate's no-behavioural-change guarantee.
 *
 * NEWEST ROW WINS when a sale has more than one. The partial live indexes
 * (`eta_submissions_order`) cap non-rejected rows at one per (tenant, docType,
 * order), so the only way to have several is a rejection superseded by a
 * corrected resubmission — and the correction is the document that counts. The
 * unfiltered `eta_submissions_order_lookup` index is what makes reading across
 * both cheap.
 *
 * The QR image is rendered from the STORED payload and only when one exists.
 * `./finalize` writes `qrPayload` as part of the receipt's fiscal identity;
 * recomputing it here could print a code that disagrees with the document ETA
 * holds.
 */
export async function getSaleFiscalStatus(
  tenantId: string,
  orderId: string,
): Promise<SaleFiscalStatus | null> {
  const row = await withTenant(tenantId, async (tx) => {
    const [found] = await tx
      .select({
        status: etaSubmissions.status,
        etaUuid: etaSubmissions.etaUuid,
        qrPayload: etaSubmissions.qrPayload,
      })
      .from(etaSubmissions)
      .where(
        and(
          eq(etaSubmissions.tenantId, tenantId),
          eq(etaSubmissions.orderId, orderId),
          eq(etaSubmissions.docType, "e_receipt"),
        ),
      )
      // LIVE ROW FIRST, then newest. The partial live indexes
      // (`eta_submissions_order`) cap non-rejected rows at one per (tenant,
      // docType, order), so "not rejected" identifies the document that counts
      // whenever one exists, and `createdAt` picks the latest rejection
      // otherwise. Ordering on `createdAt` alone would be right in every real
      // case but would resolve a same-instant tie arbitrarily — and resolving
      // it towards a superseded rejection would print "rejected" on a receipt
      // whose correction is already in flight.
      .orderBy(
        sql`(${etaSubmissions.status} <> 'rejected') desc`,
        desc(etaSubmissions.createdAt),
        desc(etaSubmissions.id),
      )
      .limit(1);
    return found ?? null;
  });

  if (!row) return null;
  return {
    status: row.status,
    etaUuid: row.etaUuid,
    qrPayload: row.qrPayload,
    qrImageDataUrl: row.qrPayload ? await QRCode.toDataURL(row.qrPayload) : null,
  };
}

export type ListSubmissionsOptions = {
  /** Rows per page. Capped so a hand-built query string cannot ask for the
   *  tenant's whole fiscal history in one response. */
  limit?: number;
  offset?: number;
  status?: EtaSubmissionStatus;
};

const SUBMISSIONS_PAGE_LIMIT = 50;

/**
 * The dashboard's submission feed: newest first, paginated, with everything the
 * table renders and nothing else. `requestJson`/`responseJson` are deliberately
 * NOT selected — they are the fiscal document and ETA's raw reply, several
 * kilobytes each, and the table shows neither.
 */
export async function listSubmissions(
  tenantId: string,
  opts: ListSubmissionsOptions = {},
): Promise<{ rows: SubmissionRowView[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 25), 1), SUBMISSIONS_PAGE_LIMIT);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);

  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: etaSubmissions.id,
        docType: etaSubmissions.docType,
        orderId: etaSubmissions.orderId,
        refundId: etaSubmissions.refundId,
        status: etaSubmissions.status,
        etaUuid: etaSubmissions.etaUuid,
        attempts: etaSubmissions.attempts,
        lastError: etaSubmissions.lastError,
        referenceOldUuid: etaSubmissions.referenceOldUuid,
        createdAt: etaSubmissions.createdAt,
        acceptedAt: etaSubmissions.acceptedAt,
      })
      .from(etaSubmissions)
      .where(
        opts.status
          ? and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.status, opts.status))
          : eq(etaSubmissions.tenantId, tenantId),
      )
      .orderBy(desc(etaSubmissions.createdAt), desc(etaSubmissions.id))
      // One extra row decides `hasMore` without a second COUNT(*) over a table
      // that only grows.
      .limit(limit + 1)
      .offset(offset),
  );

  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * One submission row, masked to the same fields the dashboard table shows.
 *
 * Exists so the resubmit route can answer 404 (no such row) and 409 (not
 * rejected, or rejected before it ever reached ETA) from data rather than by
 * pattern-matching the messages `enqueueCorrectedResubmission` throws. That
 * function stays the authority — it re-checks both preconditions inside its own
 * transaction — but a thrown `Error` with a prose message is not something an
 * HTTP layer should be discriminating on.
 */
export async function getSubmissionById(
  tenantId: string,
  submissionId: string,
): Promise<SubmissionRowView | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: etaSubmissions.id,
        docType: etaSubmissions.docType,
        orderId: etaSubmissions.orderId,
        refundId: etaSubmissions.refundId,
        status: etaSubmissions.status,
        etaUuid: etaSubmissions.etaUuid,
        attempts: etaSubmissions.attempts,
        lastError: etaSubmissions.lastError,
        referenceOldUuid: etaSubmissions.referenceOldUuid,
        createdAt: etaSubmissions.createdAt,
        acceptedAt: etaSubmissions.acceptedAt,
      })
      .from(etaSubmissions)
      .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId)))
      .limit(1);
    return row ?? null;
  });
}

/** The tenant's POS devices, for the online-device picker and the credential
 *  form. `pos_devices` carries no RLS policy, so the tenant predicate is
 *  explicit — see `assertOwnDevice`. */
export async function listFiscalDevices(
  tenantId: string,
): Promise<{ id: string; label: string; revoked: boolean }[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({ id: posDevices.id, label: posDevices.label, revokedAt: posDevices.revokedAt })
      .from(posDevices)
      .where(eq(posDevices.tenantId, tenantId))
      .orderBy(desc(posDevices.createdAt));
    return rows.map((r) => ({ id: r.id, label: r.label, revoked: r.revokedAt !== null }));
  });
}
