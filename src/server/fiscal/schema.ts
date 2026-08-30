import { pgTable, uuid, text, timestamp, integer, jsonb, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
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
 * attempts + lastError, Spec 5) so the same store-and-forward worker
 * semantics apply: a worker claims pending rows, submits them, and records
 * the outcome here. This table only holds the record — the submission
 * worker/builder is a later task.
 *
 * docType decides which parent column is populated: e_receipt/e_invoice
 * reference orderId; credit_note/return_receipt reference refundId. The
 * other of the pair stays null — this schema does not enforce that split
 * with a CHECK constraint, so the writer (later task) must honour it.
 */
export const etaSubmissions = pgTable("eta_submissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  docType: etaDocTypeEnum("doc_type").notNull(),
  orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
  refundId: uuid("refund_id").references(() => refunds.id, { onDelete: "cascade" }),
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
  requestJson: jsonb("request_json").$type<Record<string, unknown>>().notNull().default({}),
  responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The worker's claim query: pending rows, oldest first (mirrors notification_outbox_claim).
  index("eta_submissions_claim").on(t.status, t.createdAt),
  // Idempotency: at most one submission row per (tenant, docType, order). NOTE:
  // as specified this also constrains a corrected resubmission after rejection
  // (see referenceOldUuid) — the future submission worker must account for that
  // when it implements resubmission (e.g. superseding rather than inserting).
  uniqueIndex("eta_submissions_order").on(t.tenantId, t.docType, t.orderId).where(sql`order_id is not null`),
  // Same idempotency guard for refund-keyed doc types (credit_note, return_receipt).
  uniqueIndex("eta_submissions_refund").on(t.tenantId, t.docType, t.refundId).where(sql`refund_id is not null`),
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
 * same device must never read the same predecessor. The writer must claim
 * this row `FOR UPDATE` (or take an advisory lock on deviceId) before
 * reading lastUuid and writing the next one — that locking lives in the
 * submission worker/builder (later task); this table only holds the head.
 */
export const etaDeviceChains = pgTable("eta_device_chains", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  deviceId: uuid("device_id").notNull().references(() => posDevices.id, { onDelete: "cascade" }),
  /** 64-hex SHA-256 of the last issued receipt's uuid; null until the
   *  device's first receipt. */
  lastUuid: text("last_uuid"),
  lastIssuedAt: timestamp("last_issued_at", { withTimezone: true }),
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
}, (t) => [
  uniqueIndex("eta_pos_credentials_device").on(t.tenantId, t.deviceId),
]);

export type EtaSubmission = typeof etaSubmissions.$inferSelect;
export type ProductTaxCode = typeof productTaxCodes.$inferSelect;
export type EtaTenantConfig = typeof etaTenantConfig.$inferSelect;
export type EtaDeviceChain = typeof etaDeviceChains.$inferSelect;
export type EtaPosCredential = typeof etaPosCredentials.$inferSelect;
