import { and, eq, inArray, isNull, sql, lt, gt, asc, desc } from "drizzle-orm";
import { withTenant, type Tx } from "@/db/with-tenant";
import { orders, orderItems, type Order, type OrderItem } from "@/server/ordering/schema";
import { orderPayments } from "@/server/pos/tender-schema";
import { posOrderReceipts } from "@/server/pos/schema";
import { refunds, refundLines, refundPayments, type Refund, type RefundLine } from "@/server/pos/refund-schema";
import {
  etaSubmissions, etaTenantConfig, etaPosCredentials, etaDeviceChains, productTaxCodes,
  type EtaSubmission, type EtaSubmissionBuyer, type EtaWireContextConfig,
} from "./schema";
import { buildReceipt, buildReturnReceipt } from "./build-document";
import { buildInvoice } from "./build-invoice";
import { finalizeReceipt, type WireContext } from "./eta-wire";
import { toWireInvoice, attachSignatures } from "./eta-invoice-wire";
import { loadTenantSlug, signingKeyThunk } from "./config";
import { stringifyWire } from "./serialize";
import { getEtaEnv } from "./eta-env";
import { EtaConfigError } from "./eta-transport-errors";
import { IrreconcilableOrderError, ParentReceiptNotAcceptedError } from "./errors";
import {
  allocateLargestRemainder, assertDecimal, compareDecimal, divideDecimal, isZeroDecimal,
  multiplyDecimal, subtractDecimal, sumDecimal,
} from "./decimal";
import { enqueueFiscalDocument } from "./enqueue";
import { SUBMISSION_MAX_ATTEMPTS } from "./constants";
import type { FiscalDocument, FiscalSaleInput, FiscalInvoiceBuyer } from "./provider";

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

/**
 * How far BACK the reconciliation sweep will reach. Orders older than this are
 * left alone, permanently.
 *
 * Without an upper bound, the first pass after a tenant activates would adopt
 * its entire pre-activation order history and submit each one with its real
 * `dateTimeIssued` — months in the past. ETA requires submission within 24
 * hours of issuance and puts anything later through a formal Late Submission
 * Request (addendum §3), which this pipeline does not implement and cannot
 * fake: back-dating is not ours to decide, and a flood of months-old documents
 * is not a thing to do to a taxpayer's account by accident on a cron tick.
 *
 * 7 days keeps the sweep doing its actual job — catching a sale whose enqueue
 * threw, or a backlog from a short outage — while making pre-activation history
 * an explicit, human decision rather than a side effect of finishing setup. A
 * tenant that activates with genuinely recent history still gets it
 * back-submitted, up to this bound.
 */
const RECONCILE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export type FinalizeOutcome =
  /** Nothing was written: this document cannot be built YET, and that is not a
   *  failure. Today the only case is a return receipt whose parent sale has
   *  not been accepted by ETA, so its Mandatory `referenceUUID` does not exist
   *  (the worker skips WITHOUT incrementing attempts). */
  | { status: "deferred"; reason: string }
  | { status: "finalized" | "already-finalized"; deviceId: string; etaUuid: string }
  /**
   * A B2B `e_invoice`'s wire document is persisted and it is ready to submit.
   *
   * A SEPARATE VARIANT, not the one above with nullable fields, because it has
   * neither of the things that one carries and the difference is the model
   * rather than an absence: an invoice has no device (it submits under the ERP
   * credential, so there is no per-device credential to pick) and no
   * self-computed uuid (ETA assigns it). Making `deviceId`/`etaUuid` nullable on
   * the receipt variant would have let the worker's receipt path compile while
   * reaching for a device that was never resolved.
   */
  | { status: "invoice-finalized" | "invoice-already-finalized" };

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
 * hold both of these. ACCEPTED COST: because the tenant lock comes first, two
 * sales on DIFFERENT devices of the same tenant serialize through this
 * transaction during inline finalization. That is deliberate — compatibility
 * with the tenant lock `recordAuditEvent` and `placeOrder` already take is
 * worth more than the parallelism — and it is cheap at the volumes this serves:
 * the critical section is a chain read, a hash and two writes, with no network
 * call in it. A tenant ringing enough concurrent sales for it to matter needs
 * per-device lock ordering, which is a bigger change than it is worth today.
 * Re-acquiring an advisory xact lock the session already
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

    // B2B invoices take a different route entirely — no chain, no device, no
    // hash, no QR — so they branch out before any of the machinery below.
    if (row.docType === "e_invoice") return finalizeInvoiceRow(tx, tenantId, row);

    // Already hashed: its uuid, QR and requestJson are the fiscal record and
    // must not move. The device is still resolved, because the caller needs it
    // to pick the submission credential.
    // Read into a local first: the `await` on the next line invalidates
    // narrowing on a property, so `row.etaUuid` would still be `string | null`
    // inside the object literal.
    const alreadyHashed = row.etaUuid;
    if (alreadyHashed) {
      return { status: "already-finalized", deviceId: await resolveSubmissionDeviceId(tx, tenantId, row), etaUuid: alreadyHashed } as const;
    }

    // Deferral is checked before any configuration is touched: a return
    // receipt waiting on its parent is a normal, self-healing state, and
    // reporting it as a config fault would be a lie the worker then makes
    // permanent.
    const parentUuid = row.docType === "return_receipt" ? await loadParentUuid(tx, tenantId, row) : null;
    if (row.docType === "return_receipt" && !parentUuid) {
      // Returns structurally CANNOT carry a QR at issuance the way sales do
      // (addendum C5 applies to the sale receipt only): the Mandatory
      // referenceUUID does not exist until ETA accepts the parent, and there is
      // no refund slip printed at the till for one to go on anyway.
      return { status: "deferred", reason: "parent e_receipt is not accepted by ETA yet" } as const;
    }

    const deviceId = await resolveSubmissionDeviceId(tx, tenantId, row);

    // (b) LOCKS — tenant, then device. See this function's doc comment.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId})::bigint)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${deviceId}`})::bigint)`);

    // (b') RE-CHECK UNDER THE LOCKS. The `etaUuid` test above ran before either
    // lock was held, so two finalizations of the SAME row — the sale path's
    // inline call and a worker claim, which can land together because
    // `next_attempt_at` defaults to now() — could both pass it. The loser then
    // waited on the tenant lock and, without this re-read, would re-hash the
    // document against the chain head the WINNER just advanced: a second uuid
    // and QR over a receipt whose first ones are already printed, and a device
    // chain with a link nobody filed. Re-selected `FOR UPDATE` so nothing else
    // can stamp the row between this read and the write below.
    const lockedUuid = await lockedEtaUuid(tx, tenantId, submissionId);
    if (lockedUuid) return { status: "already-finalized", deviceId, etaUuid: lockedUuid } as const;

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
      ? await buildReturnDocument(tx, tenantId, row, previousUuid, deviceSerial, parentUuid!, config.wireContext)
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

    // (e) Persist the fiscal identity — CONDITIONALLY. `eta_uuid IS NULL` makes
    // the write itself refuse to overwrite an issued identity even if a future
    // caller reaches here without the locked re-check above; zero rows back
    // means someone else finalized, and the chain head must NOT advance over a
    // uuid that was never persisted.
    const stamped = await tx.update(etaSubmissions).set({
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
    }).where(and(
      eq(etaSubmissions.tenantId, tenantId),
      eq(etaSubmissions.id, submissionId),
      isNull(etaSubmissions.etaUuid),
    )).returning({ id: etaSubmissions.id });

    if (stamped.length === 0) {
      const winner = await lockedEtaUuid(tx, tenantId, submissionId);
      if (!winner) throw new Error(`fiscal: submission ${submissionId} could not be stamped and carries no etaUuid`);
      return { status: "already-finalized", deviceId, etaUuid: winner } as const;
    }

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
 * One B2B `e_invoice` row's wire document, persisted.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, and every omission is the invoice model
 * rather than a shortcut:
 *
 *   NO ADVISORY LOCKS. The receipt path takes a tenant lock and a device lock
 *   because the uuid is a hash OVER the chain predecessor, so read-then-advance
 *   must be indivisible. An invoice has no chain and no predecessor, so there is
 *   nothing to serialize and no reason to make two concurrent B2B triggers wait
 *   on each other.
 *
 *   NO `eta_device_chains` WRITE, for the same reason: an invoice is not issued
 *   from a device and joins no device's chain.
 *
 *   NO `eta_uuid` AND NO `qr_payload`. Both stay null — ETA assigns the uuid at
 *   submission (`EtaFiscalProvider.#submitInvoice` writes it back), and there is
 *   no invoice QR template to build a payload from. `hash_or_signature` also
 *   stays null: it would hold the CAdES-BES value, which is BLOCKED (see
 *   `./sign-invoice`), and writing anything else there would misrepresent an
 *   unsigned document as a signed one.
 *
 * IDEMPOTENT, keyed on the SHAPE of `request_json` rather than on `eta_uuid`,
 * which is the receipt path's key and is null here for the document's whole
 * pre-submission life. A row that already holds a wire document (it has
 * `invoiceLines`) is left exactly as it is: those bytes are what a signature
 * would have been taken over and what ETA may already hold, and rebuilding would
 * silently follow later edits to the tenant's tax codes or wire context.
 *
 * ---------------------------------------------------------------------------
 * THE BUYER READ SEAM — NOW A COLUMN (round 2, Task 4).
 *
 * A B2B invoice needs a receiver ServeOS stores nowhere (registration number,
 * name, five address components — see `FiscalInvoiceBuyer`), so the buyer is
 * captured at the TRIGGER (`config-service.requestB2bInvoice`, which owns the
 * zod that validates it in front of the operator) and reaches this pure-read
 * finalizer through `eta_submissions.buyer_json`.
 *
 * So the read is: `buyer_json`, or a PERMANENT `EtaConfigError` naming the gap.
 * Never a default, never a guess — an invoice with an invented receiver is a
 * misfiled legal document, and failing closed sends the owner an actionable
 * alert instead.
 *
 * WHAT CHANGED FROM THE ROUND-1 SEAM, AND WHAT DELIBERATELY DID NOT. Task 3
 * staged the buyer inside `request_json` because there was no column yet; only
 * `stagedBuyer` was repointed. The error, the failure family and the idempotency
 * key are byte-for-byte what they were. The legacy `request_json.buyer` fallback
 * was REMOVED rather than kept: no row has ever been staged that way outside
 * this repo's own tests (the trigger that would have written it is this task's,
 * and it writes the column), so a fallback would be dead code standing in for
 * data that does not exist.
 *
 * TWO PROPERTIES THE SPLIT PRESERVES:
 *
 *   THE WIRE OVERWRITE. `request_json` is still overwritten by the wire document
 *   below, and the buyer is still not lost by it — it survives BOTH as the
 *   wire's own `receiver` block (the authoritative record of what was filed) and
 *   now in `buyer_json` (the record of what was captured). The overwrite simply
 *   no longer touches the buyer at all.
 *
 *   THE IDEMPOTENCY KEY. Still `request_json` CONTAINING `invoiceLines`, not
 *   `request_json` being non-empty — which is what lets a row that has only been
 *   staged still be finalizable. That distinction now costs nothing (a staged
 *   row's `request_json` is exactly `{}`), and it is kept because the key must
 *   go on identifying "these are the bytes we filed" rather than "something is
 *   written here".
 */
async function finalizeInvoiceRow(tx: Tx, tenantId: string, row: EtaSubmission): Promise<FinalizeOutcome> {
  if (isWireDocument(row.requestJson)) return { status: "invoice-already-finalized" } as const;
  // Same double-finalize hazard as the receipt path, without its advisory
  // locks: two concurrent builds would each sign and write, and the second
  // write could replace bytes the first had already handed to ETA. A row lock
  // serializes them; the loser re-reads the winner's wire document and stops.
  const [locked] = await tx.select({ requestJson: etaSubmissions.requestJson }).from(etaSubmissions)
    .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, row.id)))
    .limit(1)
    .for("update");
  if (locked && isWireDocument(locked.requestJson)) return { status: "invoice-already-finalized" } as const;

  const config = await loadTenantConfig(tx, tenantId);
  const buyer = stagedBuyer(row);

  const order = await loadOrder(tx, tenantId, row.orderId!);
  const items = await loadOrderItems(tx, tenantId, order.id);
  const payments = await tx.select().from(orderPayments)
    .where(and(eq(orderPayments.tenantId, tenantId), eq(orderPayments.orderId, order.id)));
  const taxCodes = await loadTaxCodes(tx, tenantId, items);

  const built = buildInvoice({
    order, items, taxCodes, payments, buyer,
    ...(config.wireContext.feeLines ? { feeLines: config.wireContext.feeLines } : {}),
  });
  const doc: FiscalDocument = row.referenceOldUuid
    // A corrected resubmission carries the rejected document's uuid, exactly as
    // a receipt's does. Invoice v1.0 has no slot to EMIT it (that is what a
    // credit note is for, and it is still deferred), so it stays on the
    // `FiscalDocument` as the row's own audit trail rather than reaching the
    // wire — which is also why it cannot change this document's bytes.
    ? { ...built, referenceOldUuid: row.referenceOldUuid }
    : built;

  // THE VERSION FLIP, and it happens HERE rather than at submit time because
  // `documentTypeVersion` is part of the document's own bytes and therefore part
  // of what the signature covers. Choosing it later would let the signed
  // document and the transmitted document differ by exactly the field that says
  // whether the signature is checked.
  //
  //   signer configured  -> "1.0" + a CAdES-BES `signatures` element
  //   no signer          -> "0.9", unsigned
  //
  // "0.9" is honest rather than convenient: a "1.0" document with no
  // `signatures` element would be refused for a missing Mandatory field, and
  // v0.9 is "maintained as v1.0, the only difference is that signature
  // validation is disabled on this version". Whether ETA still ACCEPTS v0.9 is
  // VERIFY-gated against preprod, as is validation of the signature itself —
  // see `./sign-invoice`.
  //
  // `resolveInvoiceSigner` never falls through: material that is present but
  // unusable throws a permanent, named `EtaConfigError` rather than silently
  // downgrading a tenant who configured a seal to an unsigned document.
  //
  // DYNAMICALLY IMPORTED, for the same reason this module talks to
  // `./build-document` rather than to `EtaFiscalProvider`: `recordSale` imports
  // this file on the SALE path, and a static import would drag pkijs + asn1js
  // into every till transaction's module graph to serve a branch no receipt ever
  // takes. B2B invoices are the only caller, and they arrive through the worker.
  const { resolveInvoiceSigner, invoiceDigest, signInvoice } = await import("./sign-invoice");
  const signer = resolveInvoiceSigner({ signingKey: config.signingKey });

  const unsigned = toWireInvoice(doc, {
    rin: config.registrationNumber,
    sellerName: config.wireContext.sellerName,
    branchCode: config.wireContext.branchCode,
    branchAddress: config.wireContext.branchAddress,
    activityCode: config.wireContext.activityCode,
    internalId: String(order.orderNumber),
    documentTypeVersion: signer ? INVOICE_SIGNED_VERSION : INVOICE_UNSIGNED_VERSION,
  });

  // ETA's steps 3-5, in order: hash the document WITHOUT its signature element
  // ("no signature element yet"), sign that hash, and put the Base64 result back
  // into the document "in a new element". The unsigned form is what was hashed,
  // and `attachSignatures` only appends — so the bytes a verifier
  // re-canonicalizes are the bytes that were signed.
  const wire = signer
    ? attachSignatures(unsigned, [await signInvoice(invoiceDigest(unsigned), signer)])
    : unsigned;

  await tx.update(etaSubmissions).set({
    // `::json`, never `::jsonb`, and never Drizzle's JSON mapper — same reason
    // as the receipt path: property order and decimal literals are part of what
    // ETA (and any signature) sees.
    requestJson: sql`${stringifyWire(wire)}::json`,
    etaUuid: null,
    qrPayload: null,
    hashOrSignature: null,
  }).where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, row.id)));

  return { status: "invoice-finalized" } as const;
}

/**
 * `documentTypeVersion` for a document with no signer.
 *
 * "0.9" — invoice v0.9 is "maintained as v1.0, the only difference is that
 * signature validation is disabled on this version". A "1.0" document without a
 * `signatures` element would be refused for a missing Mandatory field, so this is
 * the only version an unsigned submission can honestly claim. Whether ETA still
 * ACCEPTS v0.9 is VERIFY-gated against preprod — see `./sign-invoice`.
 */
const INVOICE_UNSIGNED_VERSION = "0.9" as const;

/** `documentTypeVersion` for a signed document — "Must be `1.0` for this
 *  version", with `signatures` Mandatory. */
const INVOICE_SIGNED_VERSION = "1.0" as const;

/** A persisted `request_json` that is a WIRE DOCUMENT rather than staged input.
 *  `invoiceLines` is Mandatory on every invoice and appears in no staging shape,
 *  so its presence is the discriminator. */
function isWireDocument(requestJson: Record<string, unknown>): boolean {
  return Array.isArray(requestJson.invoiceLines);
}

/**
 * The buyer the B2B trigger captured. See THE BUYER READ SEAM above.
 *
 * VALIDATED AT THE DASHBOARD BOUNDARY, NOT HERE — and as of round 2 Task 4 that
 * is a fact rather than a plan. This function checks only that SOMETHING was
 * captured; `buildInvoice` then refuses an incomplete receiver with
 * `BuyerIdRequiredError`. Both of those run inside the WORKER, where the only
 * way to report a bad TRN is a `failed` submission row and an owner alert hours
 * after the fact — the wrong surface for a typo. `requestB2bInvoice`'s zod
 * (`rin: /^\d{9}$/`, non-empty name, the five mandatory address components) runs
 * at the trigger, in front of the operator, so a malformed buyer is a FORM error
 * at capture time and `BuyerIdRequiredError` is what it should be: an
 * unreachable backstop for data that got in some other way.
 *
 * `buyer_json` is nullable and typed, so the only shape this can be handed is a
 * complete `EtaSubmissionBuyer` or nothing — the round-1 "is it an object?"
 * check went away with the untyped `request_json` staging it guarded.
 */
function stagedBuyer(row: EtaSubmission): FiscalInvoiceBuyer {
  const staged = row.buyerJson;
  if (!staged) {
    throw new EtaConfigError(
      "missing-buyer",
      `fiscal: e_invoice submission ${row.id} carries no staged buyer. A B2B invoice's receiver — registration ` +
        "number, name and a five-part address — is captured at the trigger because ServeOS stores none of it on the " +
        "order, and it cannot be defaulted or inferred. Re-request the invoice with the buyer's details.",
    );
  }
  // No cast. `EtaSubmissionBuyer` and `FiscalInvoiceBuyer` are structurally
  // identical by design and this assignment is what enforces it: the round-1
  // `as unknown as` was covering for an untyped `request_json` bag, and keeping
  // it would silently absorb exactly the drift schema.ts promises is a compile
  // error.
  return staged;
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
 * The TILL's B2B entry point: a sale rung with a business buyer is declared as
 * an `e_invoice` INSTEAD of an `e_receipt`, never as well as one.
 *
 * ONE SALE, ONE DOCUMENT FAMILY, GUARANTEED AT THE SOURCE. Task 4's ladder in
 * `config-service.requestB2bInvoice` enforces the rule for the DASHBOARD, where
 * a receipt already exists and the question is whether an invoice may join it.
 * Here there is nothing to enforce against: this function is reached instead of
 * `enqueueAndFinalizeReceipt`, so the only row this sale ever gets is the
 * invoice. The sweep (`reconcileMissingReceipts`) is the third leg — it now
 * treats ANY order-carrying row as satisfying, so it cannot re-adopt this order
 * into a receipt an hour later.
 *
 * SAME TWO FAILURE CONTRACTS as the receipt path, for the same reasons: the
 * enqueue PROPAGATES (the row is the compliance record, and `record-sale.ts`
 * catches and logs), the finalize is SWALLOWED (the row exists, the worker
 * retries). What differs is what a lost finalization costs. On a receipt it is
 * the QR on one printed copy; on an invoice there is no QR to lose — ETA assigns
 * the identity at submission — so the immediate build buys FEEDBACK only, in the
 * same sense `finalizeAfterCommit` documents for the dashboard trigger.
 *
 * THE BUYER IS NOT REVALIDATED HERE, and that is deliberate rather than
 * overlooked. `buyerSchema` lives in `config-service.ts` behind zod, an audit
 * writer and a 1,300-line configuration module; importing it would put all of
 * that on the module graph of every till transaction, B2C ones included, to
 * serve a branch most sales never take. The till validates the seven fields as
 * it captures them (`apps/pos/src/fiscal/buyer.ts`, which mirrors `buyerSchema`
 * field for field), and `buildInvoice`'s `BuyerIdRequiredError` is the backstop.
 * The consequence is stated honestly: a malformed buyer that reaches here
 * becomes a `failed` invoice row and an owner alert — visible, named, and
 * correctable — and never, under any circumstance, a silent downgrade to a B2C
 * receipt, which is the one outcome that would misdeclare the sale.
 */
export async function enqueueAndFinalizeInvoice(
  ctx: { tenantId: string },
  orderId: string,
  buyer: EtaSubmissionBuyer,
): Promise<void> {
  // The buyer rides the INSERT itself — see `enqueueFiscalDocument`'s note on
  // why the till cannot use Task 4's enqueue-then-update shape.
  await enqueueFiscalDocument(ctx, { docType: "e_invoice", orderId, buyerJson: buyer });

  try {
    const [row] = await withTenant(ctx.tenantId, (tx) =>
      tx.select({ id: etaSubmissions.id }).from(etaSubmissions).where(and(
        eq(etaSubmissions.tenantId, ctx.tenantId),
        eq(etaSubmissions.docType, "e_invoice"),
        eq(etaSubmissions.orderId, orderId),
        sql`${etaSubmissions.referenceOldUuid} is null`,
      )).limit(1));

    if (row) await finalizeSubmissionRow(ctx.tenantId, row.id);
  } catch (err) {
    console.error(`[fiscal] finalize-at-enqueue failed for tenant ${ctx.tenantId} order ${orderId} docType e_invoice (row queued; the worker will retry)`, err);
  }
}

/**
 * EG orders old enough to have been fiscalised, carrying no `e_receipt` row at
 * all — enqueued and finalized here.
 *
 * IT HAS TWO JOBS, and the second one is not a fallback. Read this before
 * assuming a sale reaches ETA within seconds; for the online channel it does
 * not.
 *
 * 1. THE DETECTION SURFACE for row-less sale-path failures. `recordSale`
 *    swallows a thrown enqueue so the sale is never blocked (the iron rule),
 *    which means that failure leaves NO row — and every other monitoring
 *    surface this subsystem has (status counts, attempts, lastError) reads
 *    rows. Without this sweep, a database blip during the after-commit enqueue
 *    silently drops a receipt from the tenant's fiscal record forever.
 *
 * 2. THE PRIMARY ENQUEUE PATH FOR PAID WEB/WHATSAPP ORDERS. There is no
 *    `recordSale` equivalent on the online checkout path — nothing calls
 *    `enqueueAndFinalizeReceipt` when a web order is paid — so for those orders
 *    this sweep is not a backstop at all: it is how they become fiscal
 *    documents in the first place. The practical consequence is LATENCY. An
 *    online order waits `RECONCILE_AFTER_MS` before it is eligible and then for
 *    the next 15-minute cron tick, so it is enqueued roughly 5-20 minutes after
 *    payment rather than at commit. That is comfortably inside ETA's 24-hour
 *    window and is not a compliance problem — but it does mean the customer's
 *    online confirmation carries NO uuid and NO QR, because neither exists yet
 *    when that page renders. A storefront fiscal surface is a named follow-up
 *    (addendum §6); until it lands, an online buyer's fiscal receipt is
 *    reachable only after the fact.
 *
 * BOUNDED AT BOTH ENDS: at least `RECONCILE_AFTER_MS` old so an in-flight sale
 * is never swept out from under its own enqueue, and at most
 * `RECONCILE_HORIZON_MS` old so activating a tenant does not back-submit its
 * whole pre-ETA history past the 24-hour window.
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
  opts: { limit?: number; olderThanMs?: number; newerThanMs?: number } = {},
): Promise<{ enqueued: number }> {
  const limit = opts.limit ?? 50;
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? RECONCILE_AFTER_MS));
  const horizon = new Date(Date.now() - (opts.newerThanMs ?? RECONCILE_HORIZON_MS));

  // Read and write in separate transactions: `enqueueAndFinalizeReceipt` opens
  // its own (and takes advisory locks), so holding this select's transaction
  // across the loop would nest a tx inside a tx and pin a pool connection for
  // the whole batch.
  const stale = await withTenant(ctx.tenantId, (tx) =>
    tx.select({ id: orders.id }).from(orders)
      .where(and(
        eq(orders.tenantId, ctx.tenantId),
        lt(orders.placedAt, cutoff),
        // The back-submission horizon — see RECONCILE_HORIZON_MS.
        gt(orders.placedAt, horizon),
        sql`${orders.status} not in ('cancelled','rejected')`,
        sql`${orders.paymentStatus} not in ('unpaid','pending_verification')`,
        // ANY order-carrying document satisfies this, not just an `e_receipt`.
        // ONE SALE, ONE DOCUMENT FAMILY — a B2B sale (round 2, Task 5) enqueues
        // an `e_invoice` INSTEAD of a receipt, so a `docType = 'e_receipt'`
        // predicate here would find no receipt, adopt the order, and file a
        // SECOND document for a sale ETA already holds one for. That is not a
        // race or a rare interleaving: it is deterministic, and it fires on
        // every B2B sale that lives past `RECONCILE_AFTER_MS`.
        //
        // No docType predicate at all rather than an `in (...)` list, for the
        // same reason `config-service.requestB2bInvoice`'s pre-check dropped
        // its own: `eta_submissions_parent_xor` already guarantees the only
        // docTypes that can carry an `order_id` are `e_receipt` and
        // `e_invoice`, so enumerating them would be a second place to keep in
        // step with the constraint.
        sql`not exists (select 1 from ${etaSubmissions} where ${etaSubmissions.orderId} = ${orders.id})`,
      ))
      .orderBy(asc(orders.placedAt))
      .limit(limit));

  let enqueued = 0;
  for (const order of stale) {
    // One order's failure must not abandon the rest of the batch; the enqueue
    // half throws (see `enqueueAndFinalizeReceipt`), so it is caught here.
    try {
      await enqueueAndFinalizeReceipt(ctx, order.id);
      enqueued++;
    } catch (err) {
      console.error(`[fiscal] reconciliation enqueue failed for tenant ${ctx.tenantId} order ${order.id}`, err);
    }
  }

  // Rows that actually landed, not orders considered. This sweep exists to make
  // an invisible failure visible, so a count that also counted the ones it
  // FAILED to enqueue would read the same whether it worked or not — precisely
  // the blindness it is here to close.
  return { enqueued };
}

// ---------------------------------------------------------------------------
// Loaders — every one of them runs on the caller's tenant-scoped transaction.
// ---------------------------------------------------------------------------

/** The row's `eta_uuid`, read with a row lock — the under-lock half of the
 *  double-finalize guard in `finalizeSubmissionRow`. */
async function lockedEtaUuid(tx: Tx, tenantId: string, submissionId: string): Promise<string | null> {
  const [locked] = await tx.select({ etaUuid: etaSubmissions.etaUuid }).from(etaSubmissions)
    .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId)))
    .limit(1)
    .for("update");
  return locked?.etaUuid ?? null;
}

async function loadSubmission(tx: Tx, tenantId: string, submissionId: string): Promise<EtaSubmission> {
  const [row] = await tx.select().from(etaSubmissions)
    .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId))).limit(1);
  if (!row) throw new Error(`fiscal: eta_submissions row ${submissionId} not found for tenant ${tenantId}`);
  if (row.docType !== "e_receipt" && row.docType !== "return_receipt" && row.docType !== "e_invoice") {
    // `credit_note` — the B2B CORRECTION document — is still deferred: nothing
    // enqueues one, and it needs a `referenceUUID` model of its own that the
    // invoice engine did not build. `e_invoice` is handled, by a route that
    // computes no uuid at all (see `finalizeInvoiceRow`); the receipt family is
    // the only one that self-computes one.
    throw new Error(`fiscal: docType ${row.docType} has no finalization route — only e_receipt, return_receipt and e_invoice do`);
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

/**
 * The uuid the return receipt's Mandatory `referenceUUID` names: the order's
 * ACCEPTED sale receipt — or null while there is none yet (the caller defers).
 *
 * NOT "the original row". An order can carry several `e_receipt` rows: the
 * original and, after a rejection, corrected resubmissions (each a new
 * document with its own uuid, `referenceOldUuid` pointing back). The original
 * of a corrected sale is by definition the REJECTED one, so keying on
 * `referenceOldUuid IS NULL` (as this once did) picked exactly the document ETA
 * refused and deferred the return forever. What a return must reference is the
 * document ETA holds as valid, so the accepted row wins, latest first.
 *
 * ACCEPTED, not merely finalized: the uuid exists as soon as a sale is hashed,
 * but a return naming a receipt ETA has not accepted would name a document
 * that may never exist on ETA's side.
 *
 * NO ACCEPTED ROW:
 *   - some receipt is still live (pending / submitted / failed-but-retrying):
 *     defer, it may yet be accepted;
 *   - none exists at all: defer — the sale may not have been enqueued yet
 *     (the reconciliation sweep adopts it);
 *   - every one is terminal: `ParentReceiptNotAcceptedError`, permanent, so the
 *     owner is told to correct the sale rather than the return waiting forever.
 */
async function loadParentUuid(tx: Tx, tenantId: string, row: EtaSubmission): Promise<string | null> {
  const orderId = await loadRefundOrderId(tx, tenantId, row);
  const receipts = await tx.select({
    etaUuid: etaSubmissions.etaUuid, status: etaSubmissions.status, attempts: etaSubmissions.attempts,
  })
    .from(etaSubmissions)
    .where(and(
      eq(etaSubmissions.tenantId, tenantId),
      eq(etaSubmissions.docType, "e_receipt"),
      eq(etaSubmissions.orderId, orderId),
    ))
    .orderBy(desc(etaSubmissions.createdAt), desc(etaSubmissions.id));

  const accepted = receipts.find((receipt) => receipt.status === "accepted" && receipt.etaUuid);
  if (accepted) return accepted.etaUuid;
  if (receipts.length === 0) return null;

  const live = receipts.some((receipt) =>
    receipt.status === "pending" || receipt.status === "submitted" ||
    (receipt.status === "failed" && receipt.attempts < SUBMISSION_MAX_ATTEMPTS));
  if (live) return null;

  throw new ParentReceiptNotAcceptedError(
    orderId,
    receipts.map((receipt) => receipt.status === "failed" ? "failed permanently" : receipt.status).join(", "),
  );
}

type ResolvedConfig = {
  registrationNumber: string;
  environment: "preprod" | "prod";
  wireContext: EtaWireContextConfig;
  /**
   * The e-seal material, LAZILY. Only the B2B invoice branch calls it — a
   * receipt is not signed at all (ETA has not deployed receipt batch-signature
   * validation; addendum C7) — so resolving eagerly would let a stale B2B secret
   * ref take every receipt this tenant issues down with it. Exactly the
   * reasoning `EtaConfig.signingKey` records, sharing its one definition
   * (`signingKeyThunk`) rather than restating the column name here.
   */
  signingKey: () => string | null;
};

async function loadTenantConfig(tx: Tx, tenantId: string): Promise<ResolvedConfig> {
  const [row] = await tx.select({
    registrationNumber: etaTenantConfig.registrationNumber,
    environment: etaTenantConfig.environment,
    wireContextJson: etaTenantConfig.wireContextJson,
    signingKeyRef: etaTenantConfig.signingKeyRef,
  }).from(etaTenantConfig).where(eq(etaTenantConfig.tenantId, tenantId)).limit(1);

  if (!row) {
    throw new EtaConfigError("tenant-config-missing", `fiscal: tenant ${tenantId} has no eta_tenant_config row — ETA setup is not started`);
  }

  return {
    registrationNumber: row.registrationNumber,
    environment: row.environment,
    wireContext: requireWireContext(row.wireContextJson),
    signingKey: signingKeyThunk(row.signingKeyRef, await loadTenantSlug(tx, tenantId)),
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
  previousUuid: string, deviceSerial: string, parentUuid: string, wireContext: EtaWireContextConfig,
): Promise<BuiltDocument> {
  const [refund] = await tx.select().from(refunds)
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.id, row.refundId!))).limit(1);
  if (!refund) throw new Error(`fiscal: refund ${row.refundId} not found for submission ${row.id}`);

  const stored = await tx.select().from(refundLines)
    .where(and(eq(refundLines.tenantId, tenantId), eq(refundLines.refundId, refund.id)));
  const order = await loadOrder(tx, tenantId, refund.orderId);
  const items = await loadOrderItems(tx, tenantId, order.id);
  const taxCodes = await loadTaxCodes(tx, tenantId, items);
  const lines = stored.length > 0 ? stored : await resolveFullRefundLines(tx, tenantId, refund, items);

  return {
    doc: buildReturnReceipt({
      parentUuid, refund, lines, items, order, taxCodes,
      // Only the service-charge classification is ever consulted on a return —
      // see `FiscalRefundInput.feeLines`.
      ...(wireContext.feeLines ? { feeLines: wireContext.feeLines } : {}),
      previousUuid,
      deviceSerial,
    }),
    receiptNumber: await returnReceiptNumber(tx, tenantId, order, refund.id),
  };
}

/**
 * The lines of a HEADERLESS FULL REFUND, resolved from the parent order.
 *
 * THE PROBLEM THIS SOLVES. `issueRefund` requires lines only for a `partial`
 * refund; a `full` one "may be headerless (goodwill) or itemised" (refund.ts),
 * and both POS refund surfaces default to `kind: "full"` with `lines: []`. So
 * the single most common refund shape stores no `refund_lines` at all — and
 * receipt v1.2 marks `itemData` Mandatory, which made every one of them a
 * permanent `EmptyReturnReceiptError` and an owner alert naming nothing the
 * owner could fix. The most common refund was filing no return document.
 *
 * WHY LINES CAN BE RESOLVED AT ALL. Everything below is on record: the order's
 * items with their quantities, every prior refund's lines and payments, and
 * this refund's own `totalAmount`. Nothing is invented — the quantities are the
 * order's, less what earlier refunds already took back, and the money is this
 * refund's own stored total, split across those quantities by the same
 * largest-remainder machinery the sale document uses (so the parts sum to the
 * stored total EXACTLY, never to a rounded approximation of it).
 *
 * WHY `kind: "full"` IS NOT ENOUGH ON ITS OWN, and what the arbiter is.
 * `issueRefund` bounds a refund only by the NET-PAID CEILING — tenders less
 * prior refunds — and explicitly permits a `full` refund of less than that as a
 * goodwill gesture. So "full" does NOT mean "the whole remaining sale", and a
 * goodwill 50.00 against a 114.00 balance names no particular items. Rather
 * than guess which ones came back, this refuses: the refund's total must equal
 * the balance outstanding when it was issued, and anything else raises
 * `IrreconcilableOrderError` naming both figures. That is the same fail-closed
 * rule the wire mapper applies — a document we cannot total honestly is not
 * emitted.
 *
 * WHAT THE AMOUNTS MEAN. Each line's amount is the GROSS the customer got
 * back, not a tax-exclusive figure (`buildReturnReceipt` takes the reversed VAT
 * back out of it to get `netSale`). Splitting the refunded total across the
 * remaining items' `lineTotal`s therefore also spreads the order's discount,
 * service charge and delivery fee across them pro rata. That is a
 * simplification and is recorded as one: ETA needs `itemData`, a returned
 * service charge has no product line to sit on, and the document's total — the
 * number that is actually reported — is the stored refund total either way.
 *
 * AND WHAT THE VAT MEANS. A headerless refund writes no `refund_lines`, so its
 * VAT lives on `refunds.vatAmount` ALONE (`refund-schema.ts` says so in as many
 * words) and there is no per-line figure to map. The header is therefore split
 * across these synthetic lines by the same largest-remainder over the same
 * amounts, so the parts sum to the stored header EXACTLY and each line's share
 * is proportional to the money it returns — which, for a refund of the whole
 * outstanding balance, is precisely the VAT that money contains and precisely
 * what ETA's per-line equation re-derives. The split is an ATTRIBUTION across
 * lines the refund never named; the reported total is the stored figure.
 */
async function resolveFullRefundLines(
  tx: Tx, tenantId: string, refund: Refund, items: OrderItem[],
): Promise<RefundLine[]> {
  // A partial refund without lines cannot exist — `issueRefund` rejects it —
  // so an empty partial is a corrupted row, not a shape to reconstruct.
  if (refund.kind !== "full") {
    throw new IrreconcilableOrderError(
      refund.orderId,
      `refund ${refund.id} is ${refund.kind} but stores no refund_lines; issueRefund requires lines for a partial refund, so this row cannot be mapped`,
    );
  }

  const priorLines = await tx.select({ orderItemId: refundLines.orderItemId, quantity: refundLines.quantity })
    .from(refundLines)
    .innerJoin(refunds, eq(refundLines.refundId, refunds.id))
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.orderId, refund.orderId)));

  const takenBack = new Map<string, number>();
  for (const line of priorLines) {
    takenBack.set(line.orderItemId, (takenBack.get(line.orderItemId) ?? 0) + line.quantity);
  }

  const remaining = items
    .map((item) => ({ item, quantity: item.quantity - (takenBack.get(item.id) ?? 0) }))
    .filter((entry) => entry.quantity > 0);

  if (remaining.length === 0) {
    throw new IrreconcilableOrderError(
      refund.orderId,
      `refund ${refund.id} is a headerless full refund but every line of the order has already been returned, so there is nothing to put on the document`,
    );
  }

  const outstanding = await outstandingNetPaid(tx, tenantId, refund);
  if (compareDecimal(refund.totalAmount, outstanding) !== 0) {
    throw new IrreconcilableOrderError(
      refund.orderId,
      `refund ${refund.id} is a headerless full refund of ${refund.totalAmount}, but ${outstanding} was outstanding when it was issued. ` +
        "A full refund of part of the balance is a goodwill payment that names no items, and this mapper will not guess which came back — itemise the refund instead.",
    );
  }

  // Weight by the share of each line still outstanding, so a full refund that
  // follows a partial one splits the remainder the way the sale priced it.
  const weights = remaining.map(({ item, quantity }) =>
    quantity === item.quantity
      ? assertDecimal(item.lineTotal, "order_items.lineTotal")
      : divideDecimal("remaining line", multiplyDecimal("remaining line", item.lineTotal, String(quantity)), String(item.quantity), 5),
  );
  const amounts = allocateLargestRemainder("refund totalAmount", refund.totalAmount, weights);

  // The header VAT spread over exactly those amounts — see AND WHAT THE VAT
  // MEANS above. Guarded rather than assumed: a zero (or legacy `'0'`) header
  // has nothing to spread, and `allocateLargestRemainder` refuses a non-zero
  // total against all-zero weights, which the equality check above already
  // makes unreachable for a positive refund.
  const vats = isZeroDecimal(refund.vatAmount)
    ? amounts.map(() => "0.00")
    : allocateLargestRemainder("refunds.vatAmount", assertDecimal(refund.vatAmount, "refunds.vatAmount"), amounts);

  return remaining.map(({ item, quantity }, index) => ({
    // Synthetic rows: they are the document's lines, never persisted. `id`
    // carries the order item so an error naming a line is still traceable.
    id: `resolved:${item.id}`,
    tenantId,
    refundId: refund.id,
    orderItemId: item.id,
    quantity,
    amount: amounts[index],
    vatAmount: vats[index],
    restock: false,
  }));
}

/** The balance still refundable immediately BEFORE this refund — tenders less
 *  every earlier refund's payments. Exactly the ceiling `issueRefund` enforces,
 *  recomputed from the same stored rows. */
async function outstandingNetPaid(tx: Tx, tenantId: string, refund: Refund): Promise<string> {
  const tenders = await tx.select({ amount: orderPayments.amount }).from(orderPayments)
    .where(and(eq(orderPayments.tenantId, tenantId), eq(orderPayments.orderId, refund.orderId)));
  const priorPayments = await tx.select({ amount: refundPayments.amount, refundId: refundPayments.refundId })
    .from(refundPayments)
    .innerJoin(refunds, eq(refundPayments.refundId, refunds.id))
    .where(and(eq(refunds.tenantId, tenantId), eq(refunds.orderId, refund.orderId)));

  const paid = sumDecimal("order tenders", tenders.map((t) => t.amount));
  const returned = sumDecimal(
    "prior refund payments",
    priorPayments.filter((p) => p.refundId !== refund.id).map((p) => p.amount),
  );
  return subtractDecimal("outstanding", paid, returned);
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
