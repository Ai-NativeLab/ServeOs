import { and, eq, inArray, sql, lt, asc } from "drizzle-orm";
import { withTenant, type Tx } from "@/db/with-tenant";
import { orders, orderItems, type Order, type OrderItem } from "@/server/ordering/schema";
import { orderPayments } from "@/server/pos/tender-schema";
import { posOrderReceipts } from "@/server/pos/schema";
import { refunds, refundLines } from "@/server/pos/refund-schema";
import {
  etaSubmissions, etaTenantConfig, etaPosCredentials, etaDeviceChains, productTaxCodes,
  type EtaSubmission, type EtaWireContextConfig,
} from "./schema";
import { buildReceipt, buildReturnReceipt } from "./build-document";
import { finalizeReceipt, type WireContext } from "./eta-wire";
import { stringifyWire } from "./serialize";
import { getEtaEnv } from "./eta-env";
import { EtaConfigError } from "./eta-transport-errors";
import { enqueueFiscalDocument } from "./enqueue";
import type { FiscalDocument, FiscalSaleInput } from "./provider";

/**
 * FINALIZATION — the pure-local half of the fiscal pipeline, split out of the
 * worker so the POS sale path can run it without importing the ETA HTTP
 * client.
 *
 * A receipt's fiscal identity is computed by US, not by ETA (addendum C2): the
 * uuid is the SHA-256 of the serialized wire document, chained per POS device
 * via `previousUUID`. Nothing here talks to the network — it is a chain read,
 * a document build, a serialization and a hash — which is precisely why it can
 * run inline with the sale and give the printed receipt its QR + uuid at
 * issuance (addendum C5, the post-clearance model). Submission is what happens
 * later, asynchronously, in `./worker`.
 *
 * The same `finalizeSubmissionRow` runs from BOTH ends: best-effort at enqueue
 * time (so the customer's copy carries the QR) and authoritatively as the
 * worker's first per-row step (so a row that missed finalization — an enqueue
 * that raced a crash, a reconciliation-swept order, a refund waiting on its
 * parent — still gets one). It is idempotent: a row that already carries an
 * `etaUuid` is never rebuilt, because rebuilding would re-hash a document
 * whose chain position has since moved.
 *
 * WHY NOT THROUGH `FiscalProvider`. Steps 1-2 call `./build-document` and
 * `./eta-wire` DIRECTLY rather than via `provider.buildReceipt`, even though
 * the interface carries those two methods. Two reasons, both structural:
 * `finalizeReceipt` (step 2) is not on the interface at all, so the
 * composition already reaches past it; and this module is imported by
 * `recordSale`, which must not drag the ETA HTTP client into the sale path.
 * The provider seam stays exactly where the contract needs one — `submit` and
 * `poll`, the two steps that touch the network — and `EtaFiscalProvider`'s own
 * `buildReceipt` is a pure delegate to the same function called here.
 */

/** The predecessor value ETA expects for a device's very first receipt:
 *  "empty string value is accepted only if this is the first receipt issued
 *  from this POS" (Receipt v1.2). */
const CHAIN_GENESIS = "";

/** How stale an order must be before the reconciliation sweep adopts it —
 *  long enough that an in-flight sale is never swept out from under its own
 *  enqueue. */
const RECONCILE_AFTER_MS = 5 * 60 * 1000;

export type FinalizeOutcome =
  /** Nothing was written: this document cannot be built YET, and that is not a
   *  failure. Today the only case is a return receipt whose parent sale has
   *  not been accepted by ETA, so its Mandatory `referenceUUID` does not exist
   *  (the worker skips WITHOUT incrementing attempts). */
  | { status: "deferred"; reason: string }
  | { status: "finalized" | "already-finalized"; deviceId: string; etaUuid: string };

/**
 * Computes and persists one submission row's fiscal identity: its wire
 * document, its chained uuid and its QR url.
 *
 * ONE TRANSACTION, and it has to be: the uuid is a hash OVER the chain
 * predecessor, so reading the head, hashing against it and advancing it must
 * not be separable. A crash between the hash and the head advance would leave
 * the next receipt chaining off a uuid that was never issued.
 *
 * LOCK ORDER — tenant, THEN device. Both are `pg_advisory_xact_lock`s and both
 * can be held by the same transaction, so a fixed acquisition order is the
 * only thing standing between two concurrent finalizations and a deadlock
 * (`eta_device_chains`' own JSDoc asks for exactly this decision). Tenant
 * first, because the tenant lock is the one OTHER code already takes:
 * `recordAuditEvent` and `placeOrder` both acquire `hashtext(tenantId)`, and
 * the worker calls `recordAuditEvent` later in transactions that may already
 * hold both of these. Re-acquiring an advisory xact lock the session already
 * holds returns immediately, so tenant-before-device can never be inverted by
 * a later audit write.
 *
 * The DEVICE lock is what makes the chain correct under concurrency: two sales
 * on one device must never read the same predecessor. It must be advisory
 * rather than `SELECT ... FOR UPDATE`, because a device's FIRST receipt has no
 * `eta_device_chains` row to lock.
 *
 * @throws {EtaConfigError} the tenant/device is not configured to issue a
 * fiscal document (no wire context, no registered device, no online device).
 * PERMANENT — see the FAILURE TAXONOMY on `FiscalProvider`.
 * @throws {FiscalDocumentError} the sale/refund cannot be expressed as a valid
 * ETA document (missing tax code, unconfigured fee line, ...). Also permanent.
 */
export async function finalizeSubmissionRow(tenantId: string, submissionId: string): Promise<FinalizeOutcome> {
  return withTenant(tenantId, async (tx) => {
    const row = await loadSubmission(tx, tenantId, submissionId);

    // Already hashed: its uuid, QR and requestJson are the fiscal record and
    // must not move. The device is still resolved, because the caller needs it
    // to pick the submission credential.
    if (row.etaUuid) {
      return { status: "already-finalized", deviceId: await resolveSubmissionDeviceId(tx, tenantId, row), etaUuid: row.etaUuid } as const;
    }

    // Deferral is checked before any configuration is touched: a return
    // receipt waiting on its parent is a normal, self-healing state, and
    // reporting it as a config fault would be a lie the worker then makes
    // permanent.
    const parentUuid = row.docType === "return_receipt" ? await loadParentUuid(tx, tenantId, row) : null;
    if (row.docType === "return_receipt" && !parentUuid) {
      return { status: "deferred", reason: "parent e_receipt is not accepted by ETA yet" } as const;
    }

    const deviceId = await resolveSubmissionDeviceId(tx, tenantId, row);

    // (b) LOCKS — tenant, then device. See this function's doc comment.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${deviceId}`})::bigint)`);

    const config = await loadTenantConfig(tx, tenantId);
    const deviceSerial = await loadDeviceSerial(tx, tenantId, deviceId);

    // (c) The chain head, read under the device lock. No row = this device's
    // first receipt, which ETA spells as an empty previousUUID.
    const [head] = await tx.select().from(etaDeviceChains)
      .where(and(eq(etaDeviceChains.tenantId, tenantId), eq(etaDeviceChains.deviceId, deviceId)))
      .limit(1);
    const previousUuid = head?.lastUuid ?? CHAIN_GENESIS;

    // (d) Build the document, then the wire + uuid + QR.
    const built = row.docType === "return_receipt"
      ? await buildReturnDocument(tx, tenantId, row, previousUuid, deviceSerial, parentUuid!)
      : await buildSaleDocument(tx, tenantId, row, previousUuid, deviceSerial, config.wireContext);

    const doc: FiscalDocument = row.referenceOldUuid
      // A corrected resubmission carries the REJECTED document's uuid, which
      // lands in the wire and therefore in this document's own hash — a
      // correction is a new document, never a re-send of the old one (C3).
      ? { ...built.doc, referenceOldUuid: row.referenceOldUuid }
      : built.doc;

    const wireCtx: WireContext = {
      rin: config.registrationNumber,
      sellerName: config.wireContext.sellerName,
      branchCode: config.wireContext.branchCode,
      branchAddress: config.wireContext.branchAddress,
      deviceSerial,
      activityCode: config.wireContext.activityCode,
      receiptNumber: built.receiptNumber,
      ...(config.wireContext.syndicateLicenseNumber ? { syndicateLicenseNumber: config.wireContext.syndicateLicenseNumber } : {}),
      ...(built.discountDescription ? { discountDescription: built.discountDescription } : {}),
      ...(config.wireContext.buyerIdThreshold ? { buyerIdThreshold: config.wireContext.buyerIdThreshold } : {}),
    };

    const finalized = finalizeReceipt(doc, wireCtx, { portalBase: getEtaEnv(config.environment).portalBase });

    // (e) Persist the fiscal identity.
    await tx.update(etaSubmissions).set({
      // The EXACT bytes ETA will receive, cast rather than handed to Drizzle's
      // JSON mapper: `JSON.stringify` would turn every `WireDecimal` into
      // `{"literal":"114.00"}` and lose the unquoted literals ETA re-derives
      // the uuid from. `::json` (never `::jsonb`) keeps property order and
      // decimal text verbatim — see the column's JSDoc.
      requestJson: sql`${stringifyWire(finalized.wire)}::json`,
      etaUuid: finalized.uuid,
      qrPayload: finalized.qrUrl,
      // NOT a signature. ETA's SDK states receipt batch-signature validation
      // "will not be deployed at this point until a decision is provided by
      // ETA" (addendum C7), so a B2C e-receipt carries no e-seal. The column
      // stays provisioned for the deferred B2B e_invoice path; writing the
      // uuid or the QR into it would misrepresent an unsigned document as a
      // signed one.
      hashOrSignature: null,
    }).where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId)));

    // (f) Advance the chain head, in the same transaction as the hash that
    // used it.
    const issuedAt = new Date();
    await tx.insert(etaDeviceChains)
      .values({ tenantId, deviceId, lastUuid: finalized.uuid, lastIssuedAt: issuedAt, updatedAt: issuedAt })
      .onConflictDoUpdate({
        target: [etaDeviceChains.tenantId, etaDeviceChains.deviceId],
        set: { lastUuid: finalized.uuid, lastIssuedAt: issuedAt, updatedAt: issuedAt },
      });

    return { status: "finalized", deviceId, etaUuid: finalized.uuid } as const;
  });
}

/**
 * The SALE path's entry point: enqueue the `e_receipt` row, then give it its
 * uuid + QR immediately so the customer's printed copy can carry them.
 *
 * The two halves have deliberately different failure contracts:
 *
 *   ENQUEUE failures PROPAGATE. The row is the compliance record and the
 *   worker's only handle on this sale; `recordSale` catches and logs, and the
 *   reconciliation sweep below is what eventually notices.
 *
 *   FINALIZE failures are SWALLOWED (logged, not thrown). By then the row
 *   exists, so the worker will finalize it on its next pass — the only thing
 *   lost is the QR on this one printed receipt, which is not worth reporting
 *   as an enqueue failure or, worse, letting reach a caller that might treat
 *   it as one.
 */
export async function enqueueAndFinalizeReceipt(ctx: { tenantId: string }, orderId: string): Promise<void> {
  await enqueueFiscalDocument(ctx, { docType: "e_receipt", orderId });

  try {
    const [row] = await withTenant(ctx.tenantId, (tx) =>
      tx.select({ id: etaSubmissions.id }).from(etaSubmissions).where(and(
        eq(etaSubmissions.tenantId, ctx.tenantId),
        eq(etaSubmissions.docType, "e_receipt"),
        eq(etaSubmissions.orderId, orderId),
        // The ORIGINAL row — the one `enqueueFiscalDocument` just inserted or
        // no-opped against. A corrected resubmission (referenceOldUuid set) is
        // a different document with its own finalization.
        sql`${etaSubmissions.referenceOldUuid} is null`,
      )).limit(1));

    if (row) await finalizeSubmissionRow(ctx.tenantId, row.id);
  } catch (err) {
    // Identifiers, never the error alone: this log line is the only trace a
    // failed finalization leaves on the sale path.
    console.error(`[fiscal] finalize-at-enqueue failed for tenant ${ctx.tenantId} order ${orderId} (row queued; the worker will retry)`, err);
  }
}

/**
 * EG orders old enough to have been fiscalised, carrying no `e_receipt` row at
 * all — enqueued and finalized here.
 *
 * THIS IS THE DETECTION SURFACE for row-less sale-path failures. `recordSale`
 * swallows a thrown enqueue so the sale is never blocked (the iron rule),
 * which means that failure leaves NO row — and every other monitoring surface
 * this subsystem has (status counts, attempts, lastError) reads rows. Without
 * this sweep, a database blip during the after-commit enqueue silently drops a
 * receipt from the tenant's fiscal record forever.
 *
 * SCOPE — orders where money actually moved. `unpaid` and
 * `pending_verification` are excluded (no sale has occurred yet; a receipt
 * would be premature and its 24-hour submission clock would start early), as
 * are `cancelled`/`rejected` orders. What remains is every POS sale
 * (`recordSale`'s own enqueue is the fast path; this is its backstop) plus
 * paid online orders, which are equally a sale and equally reportable — those
 * have no POS device, which is what `eta_tenant_config.onlineDeviceId` exists
 * for.
 */
export async function reconcileMissingReceipts(
  ctx: { tenantId: string },
  opts: { limit?: number; olderThanMs?: number } = {},
): Promise<{ enqueued: number }> {
  const limit = opts.limit ?? 50;
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? RECONCILE_AFTER_MS));

  // Read and write in separate transactions: `enqueueAndFinalizeReceipt` opens
  // its own (and takes advisory locks), so holding this select's transaction
  // across the loop would nest a tx inside a tx and pin a pool connection for
  // the whole batch.
  const stale = await withTenant(ctx.tenantId, (tx) =>
    tx.select({ id: orders.id }).from(orders)
      .where(and(
        eq(orders.tenantId, ctx.tenantId),
        lt(orders.placedAt, cutoff),
        sql`${orders.status} not in ('cancelled','rejected')`,
        sql`${orders.paymentStatus} not in ('unpaid','pending_verification')`,
        sql`not exists (select 1 from ${etaSubmissions} where ${etaSubmissions.orderId} = ${orders.id} and ${etaSubmissions.docType} = 'e_receipt')`,
      ))
      .orderBy(asc(orders.placedAt))
      .limit(limit));

  for (const order of stale) {
    // One order's failure must not abandon the rest of the batch; the enqueue
    // half throws (see `enqueueAndFinalizeReceipt`), so it is caught here.
    try {
      await enqueueAndFinalizeReceipt(ctx, order.id);
    } catch (err) {
      console.error(`[fiscal] reconciliation enqueue failed for tenant ${ctx.tenantId} order ${order.id}`, err);
    }
  }

  return { enqueued: stale.length };
}

// ---------------------------------------------------------------------------
// Loaders — every one of them runs on the caller's tenant-scoped transaction.
// ---------------------------------------------------------------------------

async function loadSubmission(tx: Tx, tenantId: string, submissionId: string): Promise<EtaSubmission> {
  const [row] = await tx.select().from(etaSubmissions)
    .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId))).limit(1);
  if (!row) throw new Error(`fiscal: eta_submissions row ${submissionId} not found for tenant ${tenantId}`);
  if (row.docType !== "e_receipt" && row.docType !== "return_receipt") {
    // B2B (`e_invoice`/`credit_note`) is deferred with its trigger — nothing
    // enqueues those today, and their uuid is ETA-assigned rather than
    // self-computed, so this builder does not apply to them at all.
    throw new Error(`fiscal: docType ${row.docType} is not self-finalizing — only e_receipt and return_receipt compute their own uuid`);
  }
  return row;
}

/**
 * WHICH DEVICE'S CHAIN this document joins.
 *
 * A POS sale carries its device on `pos_order_receipts` (the idempotency row
 * `recordSale` writes). Anything else — a web or WhatsApp order — was rung on
 * no device, so it joins the chain of the device the tenant nominated for
 * exactly that purpose. A return receipt follows its PARENT SALE's device, so
 * a refund lands on the same chain as the receipt it reverses.
 */
async function resolveSubmissionDeviceId(tx: Tx, tenantId: string, row: EtaSubmission): Promise<string> {
  const orderId = row.orderId ?? (await loadRefundOrderId(tx, tenantId, row));

  const [receipt] = await tx.select({ deviceId: posOrderReceipts.deviceId })
    .from(posOrderReceipts).where(eq(posOrderReceipts.orderId, orderId)).limit(1);
  if (receipt) return receipt.deviceId;

  const [config] = await tx.select({ onlineDeviceId: etaTenantConfig.onlineDeviceId })
    .from(etaTenantConfig).where(eq(etaTenantConfig.tenantId, tenantId)).limit(1);
  if (config?.onlineDeviceId) return config.onlineDeviceId;

  throw new EtaConfigError(
    "no-fiscal-device",
    `fiscal: no fiscal device configured for online orders — order ${orderId} was not rung on a POS device and ` +
      "eta_tenant_config.online_device_id is not set. Nominate a registered POS device to carry online receipts.",
  );
}

async function loadRefundOrderId(tx: Tx, tenantId: string, row: EtaSubmission): Promise<string> {
  const [refund] = await tx.select({ orderId: refunds.orderId }).from(refunds)
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, row.refundId!))).limit(1);
  if (!refund) throw new Error(`fiscal: refund ${row.refundId} not found for submission ${row.id}`);
  return refund.orderId;
}

/** The parent sale's self-computed uuid, or null while it has none — the
 *  return receipt's Mandatory `referenceUUID`. */
async function loadParentUuid(tx: Tx, tenantId: string, row: EtaSubmission): Promise<string | null> {
  const orderId = await loadRefundOrderId(tx, tenantId, row);
  const [parent] = await tx.select({ etaUuid: etaSubmissions.etaUuid, status: etaSubmissions.status })
    .from(etaSubmissions)
    .where(and(
      eq(etaSubmissions.tenantId, tenantId),
      eq(etaSubmissions.docType, "e_receipt"),
      eq(etaSubmissions.orderId, orderId),
      sql`${etaSubmissions.referenceOldUuid} is null`,
    )).limit(1);
  // ACCEPTED, not merely finalized. The uuid exists as soon as the sale is
  // hashed, but a return referencing a receipt ETA has not accepted (or has
  // rejected) would name a document that may never exist on ETA's side.
  return parent?.status === "accepted" ? parent.etaUuid : null;
}

type ResolvedConfig = {
  registrationNumber: string;
  environment: "preprod" | "prod";
  wireContext: EtaWireContextConfig;
};

async function loadTenantConfig(tx: Tx, tenantId: string): Promise<ResolvedConfig> {
  const [row] = await tx.select({
    registrationNumber: etaTenantConfig.registrationNumber,
    environment: etaTenantConfig.environment,
    wireContextJson: etaTenantConfig.wireContextJson,
  }).from(etaTenantConfig).where(eq(etaTenantConfig.tenantId, tenantId)).limit(1);

  if (!row) {
    throw new EtaConfigError("tenant-config-missing", `fiscal: tenant ${tenantId} has no eta_tenant_config row — ETA setup is not started`);
  }

  return {
    registrationNumber: row.registrationNumber,
    environment: row.environment,
    wireContext: requireWireContext(row.wireContextJson),
  };
}

/**
 * Presence check only — the column is consumed VERBATIM.
 *
 * Full validation (the 9-digit RIN, the shape of an activity code, a decimal
 * threshold) belongs to the config service, which runs it once at save time
 * with the operator in front of it; re-validating here would move a fixable
 * data-entry mistake onto the fiscal hot path where it can only be reported as
 * a failed receipt. What this DOES refuse is a document it could only emit by
 * inventing seller identity — an absent or half-filled column — because that
 * would file a receipt under the wrong taxpayer or branch.
 */
function requireWireContext(value: EtaWireContextConfig | null): EtaWireContextConfig {
  const missing: string[] = [];
  if (!value) {
    throw new EtaConfigError(
      "wire-context-missing",
      "fiscal: eta_tenant_config.wire_context_json is not set — receipt v1.2 needs the seller's trade name, activity code, " +
        "branch code and structured branch address, none of which ServeOS stores elsewhere. Complete fiscal setup.",
    );
  }
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
  if (missing.length > 0) {
    throw new EtaConfigError(
      "wire-context-incomplete",
      `fiscal: eta_tenant_config.wire_context_json is missing ${missing.join(", ")} — every one of these is Mandatory in receipt v1.2`,
    );
  }
  return value;
}

/** The serial this device is registered under at pos.eta.gov.eg —
 *  `seller.deviceSerialNumber`, and part of the hashed document.
 *
 *  Credential STATUS is deliberately not checked here. A device that is
 *  registered but not yet activated has a known, final serial, and refusing to
 *  finalize would deny the customer the QR that the post-clearance model
 *  requires at issuance (C5). Whether the credential may actually SUBMIT is
 *  `resolveEtaConfig`'s call, and it takes it (`"active"` only). */
async function loadDeviceSerial(tx: Tx, tenantId: string, deviceId: string): Promise<string> {
  const [cred] = await tx.select({ etaSerial: etaPosCredentials.etaSerial }).from(etaPosCredentials)
    .where(and(eq(etaPosCredentials.tenantId, tenantId), eq(etaPosCredentials.deviceId, deviceId))).limit(1);
  if (!cred) {
    throw new EtaConfigError(
      "device-not-registered",
      `fiscal: POS device ${deviceId} has no eta_pos_credentials row — its ETA serial is part of every receipt it issues. ` +
        "Register the device at pos.eta.gov.eg and record its credential.",
    );
  }
  return cred.etaSerial;
}

type BuiltDocument = { doc: FiscalDocument; receiptNumber: string; discountDescription?: string };

async function buildSaleDocument(
  tx: Tx, tenantId: string, row: EtaSubmission,
  previousUuid: string, deviceSerial: string, wireContext: EtaWireContextConfig,
): Promise<BuiltDocument> {
  const order = await loadOrder(tx, tenantId, row.orderId!);
  const items = await loadOrderItems(tx, tenantId, order.id);
  const payments = await tx.select().from(orderPayments)
    .where(and(eq(orderPayments.tenantId, tenantId), eq(orderPayments.orderId, order.id)));
  const taxCodes = await loadTaxCodes(tx, tenantId, items);

  const input: FiscalSaleInput = {
    order, items, taxCodes, payments,
    ...(wireContext.feeLines ? { feeLines: wireContext.feeLines } : {}),
    previousUuid,
    deviceSerial,
  };

  return {
    doc: buildReceipt(input),
    receiptNumber: saleReceiptNumber(order),
    ...(order.discountReason ? { discountDescription: order.discountReason } : {}),
  };
}

async function buildReturnDocument(
  tx: Tx, tenantId: string, row: EtaSubmission,
  previousUuid: string, deviceSerial: string, parentUuid: string,
): Promise<BuiltDocument> {
  const [refund] = await tx.select().from(refunds)
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, row.refundId!))).limit(1);
  if (!refund) throw new Error(`fiscal: refund ${row.refundId} not found for submission ${row.id}`);

  const lines = await tx.select().from(refundLines)
    .where(and(eq(refundLines.tenantId, tenantId), eq(refundLines.refundId, refund.id)));
  const order = await loadOrder(tx, tenantId, refund.orderId);
  const items = await loadOrderItems(tx, tenantId, order.id);
  const taxCodes = await loadTaxCodes(tx, tenantId, items);

  return {
    doc: buildReturnReceipt({ parentUuid, refund, lines, items, taxCodes, previousUuid, deviceSerial }),
    receiptNumber: await returnReceiptNumber(tx, tenantId, order, refund.id),
  };
}

/**
 * `header.receiptNumber` for a sale — `orders.orderNumber`, as the plan
 * specifies.
 *
 * ETA requires it "unique per branch within the same submission".
 * `orders.orderNumber` is allocated as `MAX + 1` under the per-tenant advisory
 * lock and RLS (`placeOrder`), making it unique TENANT-WIDE — which is
 * strictly stronger than per-branch, and stronger again than per-branch
 * per-submission. `eta-wire`'s own note left this open because the uuid chain
 * is per DEVICE while this number is not: two devices in one branch cannot
 * collide either, because both draw from the same tenant-wide sequence.
 */
function saleReceiptNumber(order: Order): string {
  return String(order.orderNumber);
}

/**
 * `header.receiptNumber` for a return — `{orderNumber}-R{n}`.
 *
 * `refunds` HAS no natural document number: it carries `clientRefundId` (a
 * device-supplied idempotency key, not a fiscal identifier), an id and a
 * timestamp. So the number is derived — from the parent order's number, which
 * is tenant-wide unique, plus this refund's 1-based ordinal among that order's
 * refunds in creation order. Deterministic (the ordinal of an existing refund
 * never changes: refunds are append-only and ordered by a stored createdAt),
 * collision-free (the order number is unique, and an ordinal is unique within
 * it), and legible on a printed slip.
 *
 * Ordering by `id` after `createdAt` only matters for two refunds written in
 * the same transaction clock tick; it is there so the ordinal is total rather
 * than arbitrary.
 *
 * A corrected resubmission of a return deliberately reuses the SAME number:
 * it is the same logical document, re-issued, exactly as a corrected sale
 * reuses its order number. ETA scopes uniqueness per submission, and these are
 * different submissions.
 */
async function returnReceiptNumber(tx: Tx, tenantId: string, order: Order, refundId: string): Promise<string> {
  const siblings = await tx.select({ id: refunds.id }).from(refunds)
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.orderId, order.id)))
    .orderBy(asc(refunds.createdAt), asc(refunds.id));
  const ordinal = siblings.findIndex((refund) => refund.id === refundId) + 1;
  return `${order.orderNumber}-R${ordinal || siblings.length + 1}`;
}

async function loadOrder(tx: Tx, tenantId: string, orderId: string): Promise<Order> {
  const [order] = await tx.select().from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId))).limit(1);
  if (!order) throw new Error(`fiscal: order ${orderId} not found for tenant ${tenantId}`);
  return order;
}

function loadOrderItems(tx: Tx, tenantId: string, orderId: string): Promise<OrderItem[]> {
  return tx.select().from(orderItems)
    .where(and(eq(orderItems.tenantId, tenantId), eq(orderItems.orderId, orderId)))
    .orderBy(asc(orderItems.id));
}

function loadTaxCodes(tx: Tx, tenantId: string, items: OrderItem[]) {
  const productIds = [...new Set(items.map((item) => item.productId))];
  if (productIds.length === 0) return Promise.resolve([]);
  return tx.select().from(productTaxCodes)
    .where(and(eq(productTaxCodes.tenantId, tenantId), inArray(productTaxCodes.productId, productIds)));
}
