/**
 * The ONLY zod import in the repository (house convention elsewhere is
 * hand-rolled validators), and a declared runtime dependency as of this task —
 * it was previously a dev-only transitive of `eslint-plugin-react-hooks`, which
 * app code must not import from. Declaring it also bumped 4.4.3 → 4.5.4; see
 * §6 of `docs/ailab/specs/2026-08-30-eta-verified-findings-addendum.md`.
 *
 * ONE KIND OF EDGE CROSSES A MODULE BOUNDARY. Every exported `*Input` /
 * `RequestB2bInvoiceBuyer` type here is a `z.input<typeof …>`, and the dashboard
 * routes and server actions import them to shape their request bodies and form
 * reads. The types ERASE at compile time, so nothing zod-shaped reaches the
 * bundle or the wire — but a zod MAJOR bump that changes inference can break
 * `tsc` in `api/dashboard/fiscal/**` or `app/dashboard/**` rather than here,
 * which is a confusing place to discover it. The runtime values
 * (`FiscalConfigInputError`, its `issues`) are this module's own, precisely so
 * no route ever catches a `ZodError`.
 */
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/db/with-tenant";
import { posDevices } from "@/server/pos/schema";
import { products } from "@/server/catalog/schema";
import { orders } from "@/server/ordering/schema";
import { recordAuditEvent, type AuditActorInput } from "@/server/audit/service";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import {
  etaSubmissions,
  etaTenantConfig,
  etaPosCredentials,
  productTaxCodes,
  etaEnvironmentEnum,
  etaActivationStatusEnum,
  etaCodeSourceEnum,
  etaPosCredentialStatusEnum,
  type EtaSubmissionBuyer,
  type EtaWireContextConfig,
  type EtaEnvironment,
  type EtaActivationStatus,
  type EtaPosCredentialStatus,
  type EtaCodeSource,
} from "./schema";
import { enqueueFiscalDocument, isFiscalEnabled } from "./enqueue";
import { finalizeSubmissionRow } from "./finalize";
import { etaSecretRefPrefix, isTenantBoundSecretRef, loadTenantSlug } from "./config";

/**
 * The fiscal CONFIGURATION surface: everything an owner sets up once, read back
 * masked. Gated by `fiscal:manage` (owner only) at every entry point above this
 * module — every function here either writes a compliance record or reads one
 * that only an owner may see.
 *
 * WHAT LIVES NEXT DOOR. The per-order status the POS reads and the submission
 * feed the dashboard lists are in `./read-model`, split out along the
 * PERMISSION seam: `getSaleFiscalStatus` is reached by any cashier holding
 * `pos:sell`, and having the till import a module whose other exports mutate
 * the taxpayer's identity was the wrong shape (it also pulled `qrcode` into
 * every config import). Nothing there writes; nothing here is reachable below
 * owner.
 *
 * THE ONE NON-CONFIGURATION WRITER, and why it is here anyway.
 * `requestB2bInvoice` acts on ONE ORDER rather than on tenant setup, so on the
 * "configuration" reading it does not belong. It is here because this module's
 * real seam is the PERMISSION one stated above — `fiscal:manage`, owner only —
 * and because it is a zod-validated fiscal write whose refusals must reach the
 * operator as `FiscalConfigInputError` field paths, which is this file's
 * apparatus and nothing else's. Putting it in `./read-model` would have made
 * the cashier-reachable module a writer; putting it in `./enqueue` would have
 * put zod and an audit actor on the sale path.
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
 *
 *    The rule binds `./read-model` identically and is restated in its header;
 *    `config-service.test.ts`'s masking walk enforces it across BOTH modules
 *    from one place, so the guarantee cannot drift into two halves.
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
 *  Calculations). Anything else is refused rather than filed. Spaces and `-`
 *  are stripped first — a TRN is commonly printed `123-456-789` — and the
 *  stored value is the bare nine digits (the till's `normalizeRin` mirrors
 *  this). */
const rinSchema = z.string().transform((v) => v.replace(/[\s-]/g, "")).pipe(z.string().regex(/^\d{9}$/, "must be exactly 9 digits — ETA's Registration Identification Number"));

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
 * A `*Ref` input: WHERE the credential lives, never the credential. Optional on
 * every update so the owner can change the RIN or the environment without
 * re-typing a reference the form cannot show them; `undefined` means "leave
 * whatever is stored", and the required-on-create check below is what stops a
 * first save from landing without one.
 *
 * THE `env://` SCHEME IS REQUIRED ON SAVE, and that is a masking decision, not
 * a formatting preference. `resolveSecretRef` (./config) accepts BOTH spellings
 * — `env://ETA_SECRET_ACME` and the bare `ETA_SECRET_ACME` — and must keep
 * doing so for rows written before this rule; but when a ref is stored bare, the
 * stored VALUE and the env KEY NAME are the same characters. That collapse
 * matters because the two are treated differently on purpose: the reference is
 * write-only and must never leave this service, while the key name is
 * deliberately allowed into an error message, since an operator staring at a
 * failed receipt needs to know which variable is unset ("The thrown message
 * names the ENV KEY, which is not itself a secret" — resolveSecretRef). Forcing
 * the scheme on every new save keeps those two strings distinguishable, so the
 * masking guarantee stays checkable rather than resting on a coincidence of
 * format. Legacy bare rows keep resolving; they just cannot be re-saved bare.
 */
/**
 * The SAVE half of the tenant-bound ref namespace (`etaSecretKeyPrefix` in
 * ./config carries the rationale): every ref this save SETS must name a key in
 * the tenant's own `env://ETA_<TENANT>__<NAME>` namespace, or the save is a form
 * error naming the exact prefix to use. Refs left unset (`undefined`) or cleared
 * (`null`) are not checked — there is nothing new to point anywhere. The resolve
 * half refuses anything that got in another way.
 */
async function assertTenantBoundRefs(tx: Tx, tenantId: string, refs: Record<string, string | null | undefined>) {
  const slug = await loadTenantSlug(tx, tenantId);
  for (const [path, ref] of Object.entries(refs)) {
    if (ref && !isTenantBoundSecretRef(ref, slug)) {
      fail(path, `must name a key in this tenant's namespace — ${etaSecretRefPrefix(slug)}<NAME>, where <NAME> is ` +
        "upper-case words joined by single underscores (e.g. CLIENT_SECRET). Other environment keys cannot be referenced");
    }
  }
}

const refSchema = z
  .string()
  .trim()
  .regex(/^env:\/\/\S+$/, "must be an env:// reference naming the key that holds the credential, e.g. env://ETA_ACME__CLIENT_SECRET — never the credential itself");

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

/**
 * The B2B buyer captured at the invoice trigger — invoice v1.0's `receiver`.
 *
 * SEVEN MANDATORY FIELDS, AND THIS SCHEMA OWNS ALL SEVEN. `buildInvoice`'s
 * `BuyerIdRequiredError` also refuses an incomplete receiver, but it runs inside
 * the WORKER, where the only way to report a mistyped registration number is a
 * `failed` submission row and an owner alert hours later. Validating here makes
 * a typo a form error with the operator still looking at the form, and leaves
 * that error what it should be: an unreachable backstop for data that arrived
 * some other way. (`finalize.ts`'s `stagedBuyer` records the same division from
 * the other end.)
 *
 * `rin` reuses `rinSchema` deliberately: ETA's Registration Identification
 * Number is one kind of identifier, and the buyer's is checked to exactly the
 * shape the seller's is — a document naming a 9-digit issuer and an 8-digit
 * receiver is not well formed.
 *
 * The five address components are Mandatory in invoice v1.0's own words; the
 * rest are Optional and carried verbatim, for the same reason the seller's
 * address carries them — a field the form cannot set is a field the tenant
 * cannot comply with.
 */
const buyerSchema = z.object({
  rin: rinSchema,
  name: requiredText("the buyer's registered name"),
  address: z.object({
    // Locked to EG: a type-`B` receiver is an Egyptian business by definition
    // (a foreign buyer is receiver type `F`, which ServeOS does not file).
    // Case-insensitive on input, stored upper-case. Mirrored by the till.
    country: z.string().trim().toUpperCase().refine((v) => v === "EG", "must be EG — a B2B tax invoice names an Egyptian business"),
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
});

export type RequestB2bInvoiceBuyer = z.input<typeof buyerSchema>;

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
    await assertTenantBoundRefs(tx, tenantId, { clientSecretRef: parsed.clientSecretRef, signingKeyRef: parsed.signingKeyRef });
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
    await assertTenantBoundRefs(tx, tenantId, {
      clientSecret1Ref: parsed.clientSecret1Ref,
      clientSecret2Ref: parsed.clientSecret2Ref,
      presharedKeyRef: parsed.presharedKeyRef,
    });

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
// Product tax codes
// ---------------------------------------------------------------------------

/**
 * One product's ETA classification, as the dashboard shows it.
 *
 * Carries the product's own name and SKU because a screen listing bare uuids is
 * unusable for the job this surface exists to do — the operator is matching
 * their menu against ETA's published code tables, item by item.
 */
export type ProductTaxCodeView = {
  productId: string;
  productName: string;
  productSku: string | null;
  codeSource: EtaCodeSource;
  itemCode: string;
  egsApprovalStatus: string | null;
  taxType: string;
  taxSubType: string | null;
  unitType: string;
};

/** A product with no classification yet — the rows an operator is here to
 *  clear. Returned beside the classified ones for the same reason the devices
 *  route returns tills without credentials. */
export type UnclassifiedProductView = {
  productId: string;
  productName: string;
  productSku: string | null;
};

const productTaxCodeSchema = z.object({
  productId: z.uuid("must be a product id"),
  codeSource: z.enum(etaCodeSourceEnum.enumValues),
  itemCode: requiredText("an item code"),
  /** Only meaningful for `egs`, which ETA must APPROVE before the code may be
   *  used; GS1 codes are usable directly. Free text because ETA's status
   *  vocabulary is not published — see the column's JSDoc. */
  egsApprovalStatus: z.string().trim().min(1).nullable().optional(),
  taxType: requiredText("a tax type"),
  // Nullable, not optional, mirroring `product_tax_codes.tax_sub_type`: a line
  // tax with genuinely no sub-type must be able to say so. `toWireReceipt`
  // rejects a MISSING sub-type on a taxable line (`MissingTaxSubTypeError`), so
  // storing null here is a deliberate statement rather than an omission.
  taxSubType: z.string().trim().min(1).nullable().optional(),
  unitType: requiredText("a unit type"),
});

export type UpsertProductTaxCodeInput = z.input<typeof productTaxCodeSchema>;

/**
 * Every product this tenant sells, split by whether ETA can represent it.
 *
 * WHY THIS SURFACE EXISTS AT ALL. `product_tax_codes` had readers — the
 * document builder resolves each line's codes through it and throws
 * `MissingTaxCodeError` when a row is absent — and no writer anywhere in the
 * codebase. An EG tenant could not complete fiscal setup except by hand-writing
 * SQL, which is the same as saying they could not go live. This is the minimal
 * surface that closes that: one row per product, typed in.
 *
 * DELIBERATELY NOT the bulk EGS-lookup UI the spec defers — no code search, no
 * catalogue import, no approval polling. Those need ETA's codes API, which is
 * itself deferred; this needs nothing but the operator and the published tables.
 */
export async function listProductTaxCodes(
  tenantId: string,
): Promise<{ classified: ProductTaxCodeView[]; unclassified: UnclassifiedProductView[] }> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        productId: products.id,
        productName: products.nameEn,
        productSku: products.sku,
        code: productTaxCodes,
      })
      .from(products)
      // LEFT join FROM products, not from the codes table: the rows an operator
      // most needs to see are the ones that do not exist yet.
      .leftJoin(
        productTaxCodes,
        and(eq(productTaxCodes.productId, products.id), eq(productTaxCodes.tenantId, tenantId)),
      )
      .where(eq(products.tenantId, tenantId))
      .orderBy(products.nameEn);

    const classified: ProductTaxCodeView[] = [];
    const unclassified: UnclassifiedProductView[] = [];
    for (const row of rows) {
      const base = { productId: row.productId, productName: row.productName, productSku: row.productSku };
      if (row.code) {
        classified.push({
          ...base,
          codeSource: row.code.codeSource,
          itemCode: row.code.itemCode,
          egsApprovalStatus: row.code.egsApprovalStatus,
          taxType: row.code.taxType,
          taxSubType: row.code.taxSubType,
          unitType: row.code.unitType,
        });
      } else {
        unclassified.push(base);
      }
    }
    return { classified, unclassified };
  });
}

/**
 * Confirms `productId` is one of THIS tenant's products.
 *
 * Same shape as `assertOwnDevice` and here for a narrower reason: `products` IS
 * RLS-backed, so a cross-tenant id already reads as absent inside `withTenant` —
 * but the insert would then fail on the foreign key as an opaque 500 rather than
 * as a 400 naming the field, and the operator would be told "something went
 * wrong" about a mistake they could have fixed.
 */
async function assertOwnProduct(tx: Tx, tenantId: string, productId: string): Promise<void> {
  const [product] = await tx
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.tenantId, tenantId)))
    .limit(1);
  if (!product) fail("productId", "is not one of this tenant's products");
}

/**
 * Classifies one product for ETA, and audits it.
 *
 * UPSERT on (tenant, product) — `product_tax_codes_product` — so re-classifying
 * a product is the same operation as classifying it. Every field is replaced;
 * there is no keep-what-is-stored rule here because, unlike a credential
 * reference, every one of these values is visible on the form that submits it.
 *
 * @throws {FiscalConfigInputError} for a bad shape, or a product that is not
 * this tenant's.
 */
export async function upsertProductTaxCode(
  tenantId: string,
  input: UpsertProductTaxCodeInput,
  audit?: AuditActorInput,
): Promise<ProductTaxCodeView> {
  const parsed = parseOrThrow(productTaxCodeSchema, input);

  return withTenant(tenantId, async (tx) => {
    await assertOwnProduct(tx, tenantId, parsed.productId);

    const [existing] = await tx
      .select()
      .from(productTaxCodes)
      .where(and(eq(productTaxCodes.tenantId, tenantId), eq(productTaxCodes.productId, parsed.productId)))
      .limit(1);

    const values = {
      tenantId,
      productId: parsed.productId,
      codeSource: parsed.codeSource,
      itemCode: parsed.itemCode,
      egsApprovalStatus: parsed.egsApprovalStatus ?? null,
      taxType: parsed.taxType,
      taxSubType: parsed.taxSubType ?? null,
      unitType: parsed.unitType,
    };

    const [row] = await tx
      .insert(productTaxCodes)
      .values(values)
      .onConflictDoUpdate({
        target: [productTaxCodes.tenantId, productTaxCodes.productId],
        set: {
          codeSource: values.codeSource,
          itemCode: values.itemCode,
          egsApprovalStatus: values.egsApprovalStatus,
          taxType: values.taxType,
          taxSubType: values.taxSubType,
          unitType: values.unitType,
        },
      })
      .returning();

    const [product] = await tx
      .select({ nameEn: products.nameEn, sku: products.sku })
      .from(products)
      .where(and(eq(products.id, parsed.productId), eq(products.tenantId, tenantId)))
      .limit(1);

    await recordAuditEvent(
      auditContext(tenantId, audit),
      {
        action: "eta.product_tax_code.updated",
        entityType: "product_tax_code",
        entityId: row.id,
        summary: existing
          ? `ETA classification updated for ${product?.nameEn ?? parsed.productId}`
          : `ETA classification recorded for ${product?.nameEn ?? parsed.productId}`,
        // FIELD NAMES ONLY, matching eta.config.updated and
        // eta.device_credentials.updated. Nothing here is a credential, but one
        // house style for the whole fiscal vocabulary is worth more than a
        // per-event judgement about which values happen to be harmless.
        metadata: {
          productId: parsed.productId,
          created: !existing,
          changedFields: changedTaxCodeFields(existing ?? null, row),
          codeSource: row.codeSource,
          roleKey: audit?.roleKey ?? null,
        },
        actorType: audit?.actorType ?? "user",
      },
      tx,
    );

    return {
      productId: row.productId,
      productName: product?.nameEn ?? "",
      productSku: product?.sku ?? null,
      codeSource: row.codeSource,
      itemCode: row.itemCode,
      egsApprovalStatus: row.egsApprovalStatus,
      taxType: row.taxType,
      taxSubType: row.taxSubType,
      unitType: row.unitType,
    };
  });
}

function changedTaxCodeFields(
  before: typeof productTaxCodes.$inferSelect | null,
  after: typeof productTaxCodes.$inferSelect,
): string[] {
  if (!before) return [];
  const columns = ["codeSource", "itemCode", "egsApprovalStatus", "taxType", "taxSubType", "unitType"] as const;
  return columns.filter((column) => before[column] !== after[column]);
}

// ---------------------------------------------------------------------------
// B2B invoice trigger
// ---------------------------------------------------------------------------

/**
 * The refusals a caller has to be able to tell apart, in the shape
 * `requestResubmission` (`app/dashboard/fiscal/resubmit.ts`) established for the
 * same job: a 400 is a THROWN `FiscalConfigInputError` carrying field paths (the
 * form highlights an input), while "no such order" and "already invoiced" are
 * RETURNED, because neither is a shape problem and neither has a field to point
 * at.
 */
export type RequestB2bInvoiceOutcome =
  | { ok: true; submissionId: string }
  | { ok: false; status: 404 | 409; error: string };

/** A non-uuid id cannot be any tenant's order, and Postgres would answer it with
 *  `invalid input syntax for type uuid` rather than "not found". Checked so the
 *  refusal is the honest 404 instead of an opaque 500. */
const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

/**
 * Requests a B2B `e_invoice` for one order, with the buyer the operator typed
 * in, and records who asked for it.
 *
 * WHY THIS EXISTS AS A TRIGGER AT ALL. A B2B invoice is not something ServeOS
 * can infer: nothing on an order says the customer is a business, and invoice
 * v1.0's receiver (registration number, name, five address components) is data
 * ServeOS stores nowhere. So someone has to ask, and to type it — this is that
 * act, and `eta.invoice.requested` is the record of it.
 *
 * ---------------------------------------------------------------------------
 * ONE SALE, ONE DOCUMENT FAMILY.
 *
 * A sale is declared to ETA EITHER as an `e_receipt` OR as an `e_invoice`, never
 * as both. So this refuses an invoice for an order that already carries a
 * non-rejected receipt, and the reason is the same harm the in-family check
 * exists to prevent, one step wider: two accepted documents describing one sale
 * is that sale declared twice in the taxpayer's ETA filings. The partial unique
 * indexes cannot express this — they are keyed on (tenant, docType, order), so a
 * receipt and an invoice for one sale collide with nothing — which makes this
 * rung the ONLY thing enforcing it.
 *
 * WHAT THIS DELIBERATELY EXCLUDES, AND WHY THAT IS A GAP RATHER THAN A DECISION.
 * A customer asking for a tax invoice AFTER their receipt has been filed is a
 * real, ordinary workflow, and this refuses it. Serving it needs an ETA
 * conversion or replacement mechanism — cancel-and-reissue? a reference from the
 * invoice back to the superseded receipt? — and ServeOS's research has never
 * covered one, so there is nothing to implement against. That open question is
 * VERIFY-12 in the addendum's §5 ledger. Until it is answered, refusing is the
 * honest failure: the alternative is inventing a filing shape and finding out
 * from a tax adviser. It is NOT a bypass to be quietly relaxed — a caller who
 * needs the invoice must capture the buyer at the till so the sale is filed as
 * one from the start (round 2, Task 5).
 *
 * THE ONE PERMITTED FAMILY SWITCH: every receipt row rejected, with no
 * correction queued. Then ETA holds no document for the sale at all, and
 * refusing would leave it permanently undeclared — strictly worse than the
 * double-declaration this rule prevents, because there is nothing to double. The
 * branch is marked at its site.
 *
 * ---------------------------------------------------------------------------
 * `internalID` IS A MATCH KEY — THE ASSERTION `enqueue.ts` ASKED THIS TASK FOR.
 *
 * `finalize.ts` sets an invoice's `internalID` to `String(order.orderNumber)`,
 * and ETA's Submit Documents response keys BOTH `acceptedDocuments` and
 * `rejectedDocuments` on it, because an invoice has no uuid of its own at
 * submission. Two LIVE invoices sharing one value would cross-map ETA's assigned
 * uuid/longId onto the wrong document. Per TENANT, that cannot happen, and two
 * independent facts are what make it so:
 *
 *   1. `orders.orderNumber` is allocated MAX+1 under `placeOrder`'s per-tenant
 *      advisory lock, so it is unique tenant-wide.
 *   2. The live pre-check below (backed by the `eta_submissions_order` partial
 *      unique index) admits at most ONE non-rejected `e_invoice` per order.
 *
 * (1) makes order → internalID injective; (2) makes order → live invoice at most
 * one. Composed: at most one live invoice per internalID value, per tenant. The
 * test `two live invoices can never share an internalID` pins it end to end.
 *
 * THE CAVEAT, WHICH IS OPERATIONAL AND NOT CODE: ETA scopes document identity
 * per TAXPAYER (the RIN), not per ServeOS tenant. Two ServeOS tenants configured
 * with the SAME `registration_number` would each allocate `orderNumber` from
 * their own sequence and could therefore file two live invoices under one RIN
 * with one `internalID`. This function cannot assert that away: every query it
 * runs is inside `withTenant`, and RLS is precisely the thing stopping it from
 * seeing the other tenant's rows — a cross-tenant uniqueness check would have to
 * run outside RLS, which is a much worse trade than the risk it removes. If a
 * deployment ever maps two tenants to one RIN, `internalID` must gain a
 * tenant-discriminating prefix; until then this is a documented operating
 * constraint, ledger-worthy rather than enforceable here.
 * ---------------------------------------------------------------------------
 *
 * @throws {FiscalConfigInputError} for any buyer field that is missing or
 * malformed — routes map exactly this to a 400 with the field path intact.
 */
export async function requestB2bInvoice(
  tenantId: string,
  orderId: string,
  buyer: RequestB2bInvoiceBuyer,
  audit?: AuditActorInput,
): Promise<RequestB2bInvoiceOutcome> {
  // BEFORE the order lookup, on purpose: a bad buyer is the operator's own
  // typing and the thing they can fix, so it is reported even if the order id in
  // the URL is also wrong.
  const parsed: EtaSubmissionBuyer = parseOrThrow(buyerSchema, buyer);
  if (!isUuid(orderId)) return { ok: false, status: 404, error: "Order not found" };

  // THE FISCAL GATE, enforced HERE and not only by the dashboard hiding its
  // button: a non-EG tenant, or an EG tenant whose ETA activation is not
  // `active`, can never file a document, so an invoice row for it would sit
  // unsubmittable forever. Read BEFORE the transaction (it takes its own pool
  // connection — see `isFiscalEnabled`).
  if (!(await isFiscalEnabled(tenantId))) {
    return {
      ok: false,
      status: 409,
      error: "Tax invoices are only available once this business is activated with ETA (Egypt) — see the Fiscal page",
    };
  }

  const outcome = await withTenant(tenantId, async (tx): Promise<RequestB2bInvoiceOutcome> => {
    // `orders` is RLS-backed, so another tenant's order simply reads as absent
    // and lands on the same 404 as a fictional one — which is the right answer
    // for both: neither tells the caller whether the id exists elsewhere.
    const [order] = await tx
      .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!order) return { ok: false, status: 404, error: "Order not found" };

    // A cancelled or rejected order is not a sale, and a tax invoice for one
    // declares revenue that never happened. Refused here rather than at the
    // dashboard alone, so the API cannot do what the button will not.
    if (order.status === "cancelled" || order.status === "rejected") {
      return {
        ok: false,
        status: 409,
        error: `Order ${order.orderNumber} is ${order.status} — a cancelled sale has nothing to invoice`,
      };
    }

    // ONLY A PAID SALE IS INVOICED. An unpaid (or `pending_verification`)
    // order has not been sold yet — it may still be voided — and a filed tax
    // invoice cannot be. Refunded / partially refunded orders WERE paid and
    // pass: their correction is a credit note, not a missing invoice.
    if (order.paymentStatus === "unpaid" || order.paymentStatus === "pending_verification") {
      return {
        ok: false,
        status: 409,
        error: `Order ${order.orderNumber} is not paid yet — only a paid sale can be invoiced`,
      };
    }

    // THE FRIENDLY PRE-CHECK. The partial unique indexes are the real backstop
    // (`eta_submissions_order_original` caps originals forever;
    // `eta_submissions_order` caps live rows), but `onConflictDoNothing` fails
    // SILENTLY by design — the operator would get a success toast and no
    // invoice. Reading the rows first is what turns each index into a sentence.
    //
    // EVERY docType for this order, not just `e_invoice`: the fourth rung below
    // is CROSS-family, and the indexes cannot express it (they are keyed on
    // (tenant, docType, order), so a receipt and an invoice for one sale collide
    // with nothing). `eta_submissions_parent_xor` guarantees the only docTypes
    // that can carry an `order_id` are `e_receipt` and `e_invoice`, so this
    // needs no docType predicate at all.
    const existing = await tx
      .select({ id: etaSubmissions.id, docType: etaSubmissions.docType, status: etaSubmissions.status })
      .from(etaSubmissions)
      .where(and(
        eq(etaSubmissions.tenantId, tenantId),
        eq(etaSubmissions.orderId, orderId),
      ));

    const invoices = existing.filter((row) => row.docType === "e_invoice");
    const live = invoices.find((row) => row.status !== "rejected");
    if (live) {
      return {
        ok: false,
        status: 409,
        error: `Order ${order.orderNumber} already has a tax invoice (${live.status}) — one live invoice per sale, or the sale is declared twice`,
      };
    }
    if (invoices.length > 0) {
      // Every row is rejected, so the LIVE index would admit an insert — but the
      // ORIGINAL index would not (it ignores status), and ETA does not accept a
      // fix in place anyway. The supported move is a corrected resubmission,
      // which carries `referenceOldUuid`; saying so beats a silent no-op.
      return {
        ok: false,
        status: 409,
        error: `Order ${order.orderNumber}'s tax invoice was rejected by ETA — queue a corrected resubmission from the fiscal dashboard rather than a new invoice`,
      };
    }

    // ONE SALE, ONE DOCUMENT FAMILY — see this function's JSDoc for the rule and
    // for VERIFY-12, the open question it stands in for.
    //
    // "Non-rejected" is the whole test, and it covers the corrected-resubmission
    // case for free: a correction is itself a non-rejected `e_receipt` row for
    // this order, so a rejected receipt WITH a correction in flight is caught by
    // exactly this find, without having to reason about `referenceOldUuid`.
    const liveReceipt = existing.find((row) => row.docType === "e_receipt" && row.status !== "rejected");
    if (liveReceipt) {
      return {
        ok: false,
        status: 409,
        error:
          `Order ${order.orderNumber} is already filed with ETA as an e-receipt (${liveReceipt.status}) — issuing a ` +
          "tax invoice as well would declare the same sale twice. Converting a filed receipt into a B2B invoice " +
          "needs an ETA mechanism ServeOS does not yet have (VERIFY-12); capture the buyer at the till instead so " +
          "the sale is filed as an invoice from the start",
      };
    }
    // FALLING THROUGH HERE IS THE ONE FAMILY SWITCH THAT IS ALLOWED, and it is a
    // deliberate branch rather than an oversight: every `e_receipt` row for this
    // order is REJECTED and nobody queued a correction, so ETA holds no document
    // for this sale at all. Refusing would leave it permanently UNDECLARED,
    // which is a worse outcome than the double-declaration the rung above
    // prevents — there is nothing to double. The invoice becomes the sale's
    // first and only filing.

    // ONE TRANSACTION for the enqueue, the buyer and the audit event. The buyer
    // is the only reason this row can become a document at all, so a row that
    // exists without one is a `failed` submission and an owner alert; and an
    // unattributed invoice request is exactly the fact this event exists to
    // record. Neither is worth risking for a shorter critical section.
    await enqueueFiscalDocument({ tenantId }, { docType: "e_invoice", orderId }, tx);

    // The ORIGINAL row — the one just inserted. Same select as
    // `enqueueAndFinalizeReceipt`'s, and for the same reason:
    // `enqueueFiscalDocument` returns nothing, because on the sale path there is
    // nothing to return to.
    const [row] = await tx
      .select({ id: etaSubmissions.id, buyerJson: etaSubmissions.buyerJson })
      .from(etaSubmissions)
      .where(and(
        eq(etaSubmissions.tenantId, tenantId),
        eq(etaSubmissions.docType, "e_invoice"),
        eq(etaSubmissions.orderId, orderId),
        sql`${etaSubmissions.referenceOldUuid} is null`,
      ))
      .limit(1);
    if (!row) {
      // Unreachable: the insert above either wrote this row or conflicted with
      // one, and the ladder above proved no row existed. Thrown rather than
      // returned so it surfaces as a 500 with a redacted cause instead of a 409
      // the operator would retry forever.
      throw new Error(`fiscal: e_invoice enqueue for order ${orderId} produced no submission row`);
    }

    // THE ONE RACE THE PRE-CHECK CANNOT SEE. Two concurrent requests for the
    // same order can both read no rows (neither snapshot contains the other's
    // uncommitted insert); the second then BLOCKS on
    // `eta_submissions_order_original`, and once the first commits, its
    // `onConflictDoNothing` no-ops and the select above — a new statement, so a
    // new READ COMMITTED snapshot — returns the WINNER'S row. Without this check
    // the loser would overwrite the winner's buyer, emit a second
    // `eta.invoice.requested` for one document, and report success twice. A
    // captured buyer on a row this call did not create is exactly that
    // situation, and it gets the same 409 the pre-check would have given.
    //
    // HONESTLY LABELLED: this is a BACKSTOP whose throw site the suite cannot
    // force. `requestB2bInvoice — 409s the loser of two CONCURRENT requests`
    // fires two overlapping calls and pins the OUTCOME (one row, one audit
    // event, one `ok`) — but the first commits fast enough that the loser is
    // caught by the pre-check instead, verified by disabling this branch and
    // watching that test stay green. It is kept because the window is real
    // across processes (the worker fleet and the dashboard are not one Node
    // process), and because the alternative failure is silent: a success toast
    // for an invoice carrying someone else's buyer.
    if (row.buyerJson) {
      return {
        ok: false,
        status: 409,
        error: `Order ${order.orderNumber} already has a tax invoice (pending) — one live invoice per sale, or the sale is declared twice`,
      };
    }

    await tx
      .update(etaSubmissions)
      .set({ buyerJson: parsed })
      .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, row.id)));

    await recordAuditEvent(
      auditContext(tenantId, audit),
      {
        action: "eta.invoice.requested",
        entityType: "eta_submission",
        entityId: row.id,
        summary: `B2B tax invoice requested for order ${order.orderNumber}`,
        // FIELD NAMES ONLY, exactly as `eta.config.updated` and its siblings do
        // — and here the rule bites on something that is not a credential. The
        // buyer's registration number and name are NOT recorded: audit rows are
        // readable by every `audit:view` holder (owner AND manager), which is
        // wider than `fiscal:manage`, and the authoritative record of who was
        // invoiced is the filed document's own `receiver` block plus
        // `eta_submissions.buyer_json`. What belongs here is that an invoice was
        // requested, for which order, by whom.
        metadata: {
          orderId,
          docType: "e_invoice",
          buyerFields: Object.keys(parsed),
          roleKey: audit?.roleKey ?? null,
        },
        actorType: audit?.actorType ?? "user",
      },
      tx,
    );

    return { ok: true, submissionId: row.id };
  });

  if (outcome.ok) await finalizeAfterCommit(tenantId, outcome.submissionId);
  return outcome;
}

/**
 * Builds the queued invoice's wire document immediately, best-effort.
 *
 * MIRRORS `enqueueAndFinalizeReceipt`'s SHAPE, for a different reason. There the
 * urgency is the QR on a receipt being handed to a customer; a B2B invoice has
 * no QR and no such deadline — the worker would finalize this row within a
 * minute either way. What the immediate attempt buys is FEEDBACK: building the
 * document is what discovers an unclassified product, a missing branch address
 * or an unresolvable e-seal reference, and doing it now surfaces those to an
 * operator who is still on the page instead of as a `failed` row and an alert
 * later.
 *
 * AFTER THE COMMIT, never inside it — the request must not be rolled back by a
 * document build, and the row is the durable part.
 *
 * FAILURES ARE SWALLOWED (logged, not thrown), same contract as the receipt
 * path's finalize half: by this point the row exists and the worker will
 * finalize it on its next pass, so a failure here costs the fast feedback and
 * nothing else. Reporting it as a failed REQUEST would be a lie — the invoice
 * was requested, and it is queued.
 */
async function finalizeAfterCommit(tenantId: string, submissionId: string): Promise<void> {
  try {
    await finalizeSubmissionRow(tenantId, submissionId);
  } catch (err) {
    // Identifiers, never the buyer: this line is the only trace an
    // immediately-failed build leaves on the trigger path.
    console.error(
      `[fiscal] finalize-at-request failed for tenant ${tenantId} submission ${submissionId} (row queued; the worker will retry)`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// Devices (the config form's picker)
// ---------------------------------------------------------------------------

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
