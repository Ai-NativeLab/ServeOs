import { pgTable, uuid, text, timestamp, integer, json, jsonb, pgEnum, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "@/server/tenancy/schema";
import { orders } from "@/server/ordering/schema";
import { products } from "@/server/catalog/schema";
import { posDevices } from "@/server/pos/schema";
import { refunds } from "@/server/pos/refund-schema";

export const etaDocTypeEnum = pgEnum("eta_doc_type", ["e_receipt", "e_invoice", "credit_note", "return_receipt"]);
export const etaSubmissionStatusEnum = pgEnum("eta_submission_status", ["pending", "submitted", "accepted", "rejected", "failed"]);
export const etaEnvironmentEnum = pgEnum("eta_environment", ["preprod", "prod"]);
export const etaActivationStatusEnum = pgEnum("eta_activation_status", ["not_configured", "pending", "active", "suspended"]);
export const etaCodeSourceEnum = pgEnum("eta_code_source", ["gs1", "egs"]);
export const etaPosCredentialStatusEnum = pgEnum("eta_pos_credential_status", ["registered", "active", "expired", "retired"]);

/**
 * One row per fiscal document submitted to ETA (e-receipt, e-invoice, credit
 * note, or return receipt). Mirrors notification_outbox's shape (status +
 * attempts + lastError + nextAttemptAt backoff clock, Spec 5) so the same
 * store-and-forward worker semantics apply: a worker claims pending rows,
 * submits them, and records the outcome here. This table only holds the
 * record — the submission worker/builder is a later task.
 *
 * docType decides which parent column is populated: e_receipt/e_invoice
 * reference orderId; credit_note/return_receipt reference refundId. The
 * other of the pair stays null — enforced by the eta_submissions_parent_xor
 * CHECK constraint below, not left to the writer.
 */
export const etaSubmissions = pgTable("eta_submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  docType: etaDocTypeEnum("doc_type").notNull(),
  /** RESTRICT, not cascade: a fiscal submission is under 5-year statutory
   *  retention, so deleting its parent order/refund must not silently
   *  cascade the fiscal record away. Exactly one of orderId/refundId is set
   *  per docType — see the eta_submissions_parent_xor CHECK below. */
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "restrict" }),
  refundId: uuid("refund_id").references(() => refunds.id, { onDelete: "restrict" }),
  status: etaSubmissionStatusEnum("status").notNull().default("pending"),
  /** For e_receipt/return_receipt this is the SELF-COMPUTED SHA-256 uuid
   *  (client-side, chained per device via eta_device_chains) — known before
   *  submission. For e_invoice, ETA assigns this uuid; it stays null until
   *  ETA's response arrives. */
  etaUuid: text("eta_uuid"),
  /** ETA-returned; used to build the public QR-code verification link. */
  etaLongId: text("eta_long_id"),
  /** ETA's per-submission (batch) id, returned in the HTTP 202 response. */
  submissionUuid: text("submission_uuid"),
  /** A corrected resubmission after rejection is a NEW row with a NEW
   *  etaUuid; this column holds the rejected document's uuid (ETA's
   *  identifier, not our id — not a FK). */
  referenceOldUuid: text("reference_old_uuid"),
  qrPayload: text("qr_payload"),
  hashOrSignature: text("hash_or_signature"),
  /**
   * requestJson/responseJson are the fiscal document payload and ETA's raw
   * response. Bearer tokens and auth headers must NEVER be persisted into
   * either column.
   *
   * `json`, NOT `jsonb`, and this is load-bearing rather than a style choice.
   * A receipt's uuid is the SHA-256 of its serialized document, and ETA's
   * serialization walks properties IN DOCUMENT ORDER — so property order is
   * part of the fiscal identity. `jsonb` normalizes: it sorts keys by length
   * then bytes (verified against this deployment, not assumed), which means a
   * document written to a `jsonb` column comes back in a DIFFERENT order and
   * can never be re-serialized into the bytes that were hashed. Since the
   * common path finalizes a receipt at sale time and submits it minutes later
   * from the worker, that round trip is unavoidable — so the column has to be
   * the one Postgres stores verbatim.
   *
   * `json` also preserves decimal literals (`114.00` does not collapse to
   * `114`), which matters for the same reason: ETA re-derives the uuid from
   * the bytes it receives.
   *
   * CONSEQUENCE FOR WRITERS: never hand this column a plain object built from
   * the wire — `JSON.stringify` turns a `WireDecimal` into `{"literal":"..."}`.
   * Write `sql`${stringifyWire(wire)}::json`` and read it back with
   * `request_json::text` + `parseWire` (see ./finalize and ./parse-wire).
   * Nothing indexes this column or uses a jsonb operator on it, so the type
   * change costs nothing.
   */
  requestJson: json("request_json").$type<Record<string, unknown>>().notNull().default({}),
  responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
  attempts: integer("attempts").notNull().default(0),
  /** Backoff clock, same role as notification_outbox.nextAttemptAt: attempts
   *  alone cannot express "eligible again at T" across worker restarts. */
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The worker's claim query: pending rows, oldest-eligible first (mirrors notification_outbox_claim).
  index("eta_submissions_claim").on(t.status, t.nextAttemptAt),
  // ORIGINAL-document uniqueness: at most one row with no referenceOldUuid per
  // (tenant, docType, order) — forever, regardless of status. A corrected
  // resubmission (a row that DOES carry referenceOldUuid) falls outside this
  // predicate and is admitted freely. A first-time-submission enqueue
  // (onConflictDoNothing) must target THIS partial index, predicate included;
  // the status<>'rejected' pair below still caps live (non-rejected) docs at one.
  uniqueIndex("eta_submissions_order_original").on(t.tenantId, t.docType, t.orderId).where(sql`${t.orderId} is not null and ${t.referenceOldUuid} is null`),
  // Same original-document guard for refund-keyed doc types.
  uniqueIndex("eta_submissions_refund_original").on(t.tenantId, t.docType, t.refundId).where(sql`${t.refundId} is not null and ${t.referenceOldUuid} is null`),
  // Idempotency: unique per (tenant, docType, order) among non-rejected rows —
  // a rejected document may be superseded by a corrected resubmission row
  // referencing it via referenceOldUuid; enqueue idempotency (onConflictDoNothing)
  // must target this partial index INCLUDING its predicate.
  uniqueIndex("eta_submissions_order").on(t.tenantId, t.docType, t.orderId).where(sql`${t.orderId} is not null and ${t.status} <> 'rejected'`),
  // Same idempotency guard for refund-keyed doc types (credit_note, return_receipt):
  // unique per (tenant, docType, refund) among non-rejected rows — same
  // resubmission and onConflictDoNothing-target caveat as eta_submissions_order.
  uniqueIndex("eta_submissions_refund").on(t.tenantId, t.docType, t.refundId).where(sql`${t.refundId} is not null and ${t.status} <> 'rejected'`),
  // Plain (non-partial) lookups: the partial indexes above intentionally hide
  // rejected/superseded rows, so a full per-order/per-refund history read
  // (audit, support — "show me every submission, including rejected") needs
  // its own unfiltered index.
  index("eta_submissions_order_lookup").on(t.tenantId, t.orderId),
  index("eta_submissions_refund_lookup").on(t.tenantId, t.refundId),
  // Fiscal-identity uniqueness: etaUuid is the document's identity (self-computed
  // for receipts, ETA-assigned for invoices) — unique per tenant once set.
  uniqueIndex("eta_submissions_eta_uuid").on(t.tenantId, t.etaUuid).where(sql`${t.etaUuid} is not null`),
  // docType decides which parent column is populated — see table JSDoc.
  check(
    "eta_submissions_parent_xor",
    sql`(doc_type in ('e_receipt','e_invoice') and order_id is not null and refund_id is null) or (doc_type in ('credit_note','return_receipt') and refund_id is not null and order_id is null)`,
  ),
]);

/**
 * Per-product fiscal classification — the ETA tax/unit codes a product's
 * order lines submit under. One row per product; a product with no row here
 * cannot be represented on a fiscal document (enforced by the future
 * builder, not by this schema).
 */
export const productTaxCodes = pgTable("product_tax_codes", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  productId: uuid("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  /** GS1 codes are usable directly. EGS codes must be APPROVED by ETA via
   *  the codes API before use — see egsApprovalStatus. */
  codeSource: etaCodeSourceEnum("code_source").notNull(),
  /** The GS1 or EGS item code (rename of the earlier egsCode concept — this
   *  single column now covers both code sources). */
  itemCode: text("item_code").notNull(),
  /** Only meaningful when codeSource = "egs"; unused for GS1 codes. */
  egsApprovalStatus: text("egs_approval_status"),
  /** ETA tax-type code, e.g. "T1" for VAT. */
  taxType: text("tax_type").notNull(),
  taxSubType: text("tax_sub_type"),
  /** ETA unit-of-measure code, e.g. "EA". */
  unitType: text("unit_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("product_tax_codes_product").on(t.tenantId, t.productId),
]);

/**
 * The stored half of `WireContext` (`./eta-wire`) — every receipt v1.2 field
 * that is tenant CONFIGURATION rather than sale data or a credential.
 *
 * Written out here rather than imported from `./eta-wire` so this schema
 * module keeps its one-way dependency (schema -> nothing fiscal). Drift is a
 * COMPILE error, not a silent one: `./finalize` assembles a real `WireContext`
 * (and `FiscalSaleInput["feeLines"]`) out of these fields, so a field added to
 * or renamed on either of those types fails to typecheck at that assembly
 * site.
 *
 * Deliberately NOT split per branch: ServeOS has no ETA branch registry, so
 * one branch code + address serves the tenant. A multi-branch EG tenant needs
 * this promoted to a per-branch row — noted rather than pre-built.
 *
 * VALIDATION belongs to the config service (Task 6), which runs it ONCE with
 * the operator in front of it (the same division `resolveEtaConfig` documents).
 * The worker consumes this column verbatim and only reports what it cannot
 * assemble at all.
 */
export type EtaWireContextConfig = {
  /** `seller.companyTradeName`. */
  sellerName: string;
  /** `seller.activityCode`, from ETA's Activity Codes table. */
  activityCode: string;
  /** `seller.branchCode` as registered with ETA. */
  branchCode: string;
  /** `seller.branchAddress` — Mandatory nested structure; `branches.address`
   *  is one free-text line and cannot fill it. */
  branchAddress: {
    country: string;
    governate: string;
    regionCity: string;
    street: string;
    buildingNumber: string;
    postalCode?: string;
    floor?: string;
    room?: string;
    landmark?: string;
    additionalInformation?: string;
  };
  /** `seller.syndicateLicenseNumber` — Optional; "C" for a company. */
  syndicateLicenseNumber?: string;
  /** Fiscal classification for the fee lines a receipt may carry. Receipt
   *  v1.2's own `feesAmount` accepts only zero, so a service charge or
   *  delivery fee ships as its own `itemData` line and needs item/tax codes
   *  exactly like a product does. */
  feeLines?: {
    serviceCharge?: EtaFeeLineConfig;
    delivery?: EtaFeeLineConfig;
  };
  /** The amount at or above which a natural-person (`P`) buyer must be
   *  identified. Omitted = ETA's published 150,000 EGP for v1.2. */
  buyerIdThreshold?: string;
};

/** One fee's fiscal classification — mirrors `FeeLineConfig` (`./provider`). */
export type EtaFeeLineConfig = {
  itemCode: string;
  codeSource: EtaCodeSource;
  taxType: string;
  taxSubType: string | null;
  unitType: string;
  description: string;
  internalCode: string;
};

/**
 * One row per EG tenant — the ERP-LEVEL ETA credential, used for B2B
 * e_invoice submission and the codes (GS1/EGS) APIs. E-receipt submission
 * does NOT use this: each POS device authenticates with its own credential
 * instead (see eta_pos_credentials) — this table is not read on the receipt
 * path.
 */
export const etaTenantConfig = pgTable("eta_tenant_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Taxpayer Registration Identification Number (RIN). */
  registrationNumber: text("registration_number").notNull(),
  clientId: text("client_id").notNull(),
  /** Secret-manager/env REFERENCE — never the secret value itself. */
  clientSecretRef: text("client_secret_ref").notNull(),
  /** Reference to the e-seal signing material. Required only for B2B
   *  e_invoice signing — receipt batch-signature validation is not enforced
   *  by ETA today, so this stays null for receipt-only tenants. */
  signingKeyRef: text("signing_key_ref"),
  environment: etaEnvironmentEnum("environment").notNull().default("preprod"),
  activationStatus: etaActivationStatusEnum("activation_status").notNull().default("not_configured"),
  /**
   * The POS device an ONLINE order's receipt is issued from.
   *
   * ETA scopes the e-receipt uuid chain and the submission credential to a
   * registered POS device, but a web/WhatsApp order was rung on no device at
   * all. Rather than invent a chain per channel, the tenant nominates one
   * registered device to carry every deviceless sale, so those receipts join
   * a real chain under a real credential.
   *
   * RESTRICT, not cascade or set-null: deleting the nominated device out from
   * under this column would silently strand every future online sale (or, on
   * cascade, take the whole config row with it). The tenant must nominate a
   * replacement first.
   *
   * Null is a legitimate state (a tenant that sells only at the till); an
   * online order on a tenant with no nomination fails its submission with a
   * permanent, owner-actionable `EtaConfigError` rather than guessing.
   */
  onlineDeviceId: uuid("online_device_id").references(() => posDevices.id, { onDelete: "restrict" }),
  /**
   * The non-credential half of what receipt v1.2 requires and ServeOS does
   * not otherwise store — see `EtaWireContextConfig`. Null until the tenant
   * completes fiscal setup; a submission with no wire context fails
   * permanently rather than emitting a document with invented seller data.
   */
  wireContextJson: jsonb("wire_context_json").$type<EtaWireContextConfig>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("eta_tenant_config_tenant").on(t.tenantId),
]);

/**
 * Per-device receipt uuid chain head. E-receipts chain via a previousUUID
 * field per POS device; this row holds the last issued uuid so the next
 * receipt can reference it. lastUuid is null only for a device's very first
 * receipt.
 *
 * Advancing the chain must be concurrency-safe: two concurrent sales on the
 * same device must never read the same predecessor. The house pattern for
 * this (recordAuditEvent, src/server/audit/service.ts) is: take
 * `pg_advisory_xact_lock(hashtext(<key>)::bigint)` to serialize the
 * read-then-advance window, read the head with a genesis default (no row
 * yet = the device's first receipt), then upsert via `onConflictDoUpdate`.
 * Plain `SELECT ... FOR UPDATE` is not enough on its own — the device's
 * FIRST receipt has no row to lock yet — so the lock must be advisory,
 * keyed on deviceId, taken before the read. That locking lives in the
 * submission worker/builder (later task); this table only holds the head.
 *
 * Lock-ordering note for that later task: recordAuditEvent already takes
 * `pg_advisory_xact_lock(hashtext(tenantId)::bigint)` inside the same sale
 * transaction. The device-keyed lock here is a SECOND advisory lock taken
 * in that same transaction — the worker must define and document a fixed
 * acquisition order between the two (e.g. tenant lock, then device lock) so
 * two concurrent transactions can never deadlock by acquiring them in
 * opposite orders.
 */
export const etaDeviceChains = pgTable("eta_device_chains", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** RESTRICT, not cascade: deleting the device out from under its chain
   *  head would silently let a replacement row for that device restart the
   *  uuid chain at null, breaking the tamper-evident chain guarantee. */
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "restrict" }),
  /** 64-hex SHA-256 of the last issued receipt's uuid; null until the
   *  device's first receipt. */
  lastUuid: text("last_uuid"),
  lastIssuedAt: timestamp("last_issued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("eta_device_chains_device").on(t.tenantId, t.deviceId),
]);

/**
 * Per-device ETA API identity. ETA issues each registered POS device its own
 * Client ID + Secret 1/Secret 2. Requesting a token additionally requires
 * posserial/pososversion/posmodelframework/presharedkey headers; issued
 * tokens are short-lived (1h TTL) — this table holds the credential material
 * a token request needs, not tokens themselves.
 */
export const etaPosCredentials = pgTable("eta_pos_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  /** The serial registered at pos.eta.gov.eg. ETA caps this at 100 chars. */
  etaSerial: text("eta_serial").notNull(),
  clientId: text("client_id").notNull(),
  /** clientSecret1Ref / clientSecret2Ref are secret-manager references —
   *  never the raw secret values. */
  clientSecret1Ref: text("client_secret_1_ref").notNull(),
  clientSecret2Ref: text("client_secret_2_ref").notNull(),
  /** Required at token-request time, but how the ETA portal provisions this
   *  value is not publicly documented — hence nullable until that
   *  provisioning flow is confirmed. */
  presharedKeyRef: text("preshared_key_ref"),
  posOsVersion: text("pos_os_version"),
  posModelFramework: text("pos_model_framework"),
  status: etaPosCredentialStatusEnum("status").notNull().default("registered"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("eta_pos_credentials_device").on(t.tenantId, t.deviceId),
]);

export type EtaSubmission = typeof etaSubmissions.$inferSelect;
export type ProductTaxCode = typeof productTaxCodes.$inferSelect;
export type EtaTenantConfig = typeof etaTenantConfig.$inferSelect;
export type EtaDeviceChain = typeof etaDeviceChains.$inferSelect;
export type EtaPosCredential = typeof etaPosCredentials.$inferSelect;
export type EtaDocType = (typeof etaDocTypeEnum.enumValues)[number];
export type EtaSubmissionStatus = (typeof etaSubmissionStatusEnum.enumValues)[number];
export type EtaEnvironment = (typeof etaEnvironmentEnum.enumValues)[number];
export type EtaActivationStatus = (typeof etaActivationStatusEnum.enumValues)[number];
export type EtaCodeSource = (typeof etaCodeSourceEnum.enumValues)[number];
export type EtaPosCredentialStatus = (typeof etaPosCredentialStatusEnum.enumValues)[number];
