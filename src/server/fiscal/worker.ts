import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { emptyFingerprint } from "@/server/audit/fingerprint";
import type { AuditContext } from "@/server/audit/service";
import { etaSubmissions } from "./schema";
import type { EtaDocType, EtaSubmissionStatus } from "./schema";
import { resolveEtaConfig } from "./config";
import { resolveFiscalProvider } from "./index";
import type { EtaConfig, FinalizedFiscalDocument, FiscalProvider, FiscalSubmitResult } from "./provider";
import { FiscalDocumentError } from "./errors";
import { EtaConfigError, EtaTransportError } from "./eta-transport-errors";
import { FISCAL_AUDIT_ACTIONS, recordFiscalAudit, notifyFiscalFailure } from "./effects";
import { finalizeSubmissionRow, reconcileMissingReceipts } from "./finalize";
import { parseWire } from "./parse-wire";

/**
 * `drainEtaSubmissions` — the async submission worker, mirroring Spec 5's
 * email outbox drain (`src/server/notifications/worker.ts`) because
 * `eta_submissions` is deliberately the same store-and-forward shape.
 *
 * FOUR STEPS, in the order `FiscalProvider`'s COMPOSITION block sets out:
 * build -> finalize (both pure, both in `./finalize`) -> submit -> poll. Only
 * the last two touch the network, and only they can fail transiently.
 *
 * The sale is never in this path. By the time a row is claimed the money has
 * been taken and the receipt printed, so every failure here resolves to a row
 * status plus an owner-facing alert — never to a reversed sale.
 */

/**
 * The attempt cap. Six retries on the schedule below spans roughly 30 minutes
 * of transient failure before a row is parked for a human.
 *
 * It is also the guard on ONE genuinely non-idempotent retry: `submit` throws
 * when ETA returns a 202 it cannot parse, and re-POSTing that document is only
 * safe inside ETA's ~10-minute duplicate-submission window (see the long note
 * on that throw in `eta-provider.ts`). The cap plus the 422 `DuplicateSubmission`
 * response — which arrives as a retryable `EtaTransportError` carrying
 * `retryAfterSeconds` — is what keeps that bounded.
 */
export const MAX_ATTEMPTS = 6;

/** Same base and shape as the notifications outbox: `2 ** attempts * base`. */
const BACKOFF_BASE_MS = 30 * 1000;

/** How long to wait before re-polling a submission ETA is still processing.
 *  Not a backoff — nothing failed — so it does not grow and does not consume
 *  an attempt. */
const POLL_INTERVAL_MS = 60 * 1000;

/**
 * The claim lease. `eta_submissions` has no "in flight" status to flip a row
 * into (its enum is the FISCAL lifecycle, and inventing a transport state
 * there would make the fiscal record lie), so exclusivity rides on
 * `nextAttemptAt` instead: claiming pushes it out of the eligible window, the
 * same trick the outbox worker's `STALL_RECLAIM_MS` uses. `FOR UPDATE SKIP
 * LOCKED` alone would not do it — those row locks die with the claim
 * transaction, and each row is then processed in its own.
 *
 * THIS NUMBER IS COUPLED TO ETA'S DUPLICATE WINDOW. Do not raise it without
 * reading the arithmetic:
 *
 *     CLAIM_LEASE_MS (5 min) + ETA_HTTP_TIMEOUT_MS (60s, ./eta-provider)
 *       < ETA's ~10-minute DuplicateSubmission window
 *
 * A lease can expire while a submit is still in flight; when it does, a second
 * drain claims the same row and POSTs the same document again. That is only
 * SAFE because ETA answers the second copy with 422 `DuplicateSubmission` —
 * "identical submission detected based on the previous submissions sent by the
 * same taxpayer within the past 10 minutes" — which arrives as a retryable
 * `EtaTransportError` carrying `Retry-After`. The 60s fetch timeout is what
 * bounds how far past the lease an in-flight call can run, and it is the reason
 * that timeout exists at all: without it a hung connection could outlive the
 * window entirely.
 *
 * Push the lease (or the timeout) past ~10 minutes and that guarantee is gone:
 * the re-POST lands outside ETA's dedupe and files a SECOND legal document for
 * one sale. There is no cheap way to unfile one.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * ETA error codes that can never succeed on a retry, from Submit Receipt
 * Documents: `BadStructure` ("a structural error with the submission
 * message"), `MaximumSizeExceeded` ("the size of the submission exceeds
 * allowed limit") and `IncorrectSubmitter` ("trying to submit them on behalf
 * of the other taxpayer"). The identical payload will fail identically every
 * time, so burning six attempts on one only delays the alert that a human has
 * to act on.
 *
 * They arrive as `EtaTransportError` and not as a `"rejected"` result on
 * purpose — the transport layer reserves rejection for the 202 body's
 * `rejectedDocuments`, and none of these codes says a receipt was judged (see
 * the AMBIGUITY note on `EtaTransportError`). That layer left the decision of
 * what to DO with them to this one; this is that decision.
 */
const PERMANENT_ETA_ERROR_CODES: ReadonlySet<string> = new Set(["BadStructure", "MaximumSizeExceeded", "IncorrectSubmitter"]);

/** One claimed row — only the columns the drive loop branches on. */
type ClaimedRow = {
  id: string;
  docType: EtaDocType;
  status: EtaSubmissionStatus;
  attempts: number;
  submissionUuid: string | null;
};

export type DrainOptions = {
  /** Injectable so tests drive the real worker against a fake ETA. Defaults to
   *  the per-tenant provider (`EtaFiscalProvider` for EG). */
  provider?: FiscalProvider;
  /** Rows claimed per tenant per pass, and the reconciliation sweep's cap. */
  limit?: number;
  /** The clock every computed timestamp is taken from (`submittedAt`,
   *  `acceptedAt`, every `nextAttemptAt`), so a test can assert an exact
   *  backoff instead of a tolerance. Claim eligibility still uses the DATABASE
   *  clock — a lease other workers must honour cannot be set by one worker's
   *  idea of the time. */
  now?: () => Date;
  /** Skips the reconciliation sweep. For tests that want to drive the claim
   *  loop alone; production always sweeps. */
  reconcile?: boolean;
};

export type DrainResult = {
  processed: number;
  /** Handed to ETA and awaiting a verdict — not terminal; the poll phase
   *  decides. */
  submitted: number;
  accepted: number;
  rejected: number;
  failed: number;
  /** Claimed but intentionally left alone: config inactive, a return receipt
   *  still waiting on its parent, or a poll ETA has not finished. No attempt
   *  was consumed. */
  deferred: number;
  /** Orders the reconciliation sweep found with no submission row at all, and
   *  successfully enqueued. */
  reconciled: number;
  /** EG tenants passed over entirely because their ETA config is absent or not
   *  active — the onboarding backlog, not an error count. */
  skippedTenants: number;
};

/**
 * One scheduled pass: reconcile, claim, then drive each claimed row through
 * finalize -> submit -> poll.
 *
 * PER-TENANT, because `eta_submissions` is FORCE RLS and a claim has to run
 * inside `withTenant` — the same reason `drainOutbox` iterates tenants. Only
 * EG tenants are visited: the fiscal subsystem is country-gated end to end
 * (F1/F2), and a non-EG tenant has no rows to find.
 *
 * PER-ROW TRANSACTIONS, deliberately: one poison row (an order whose items
 * cannot be classified, a device with no credential) must fail alone and let
 * its siblings through. Its status write is atomic with the audit event and
 * the notification that explain it.
 */
export async function drainEtaSubmissions(opts: DrainOptions = {}): Promise<DrainResult> {
  const limit = opts.limit ?? 20;
  const now = opts.now ?? (() => new Date());
  const result: DrainResult = {
    processed: 0, submitted: 0, accepted: 0, rejected: 0, failed: 0, deferred: 0, reconciled: 0, skippedTenants: 0,
  };

  const egTenants = await db.select({ id: tenants.id, country: tenants.country })
    .from(tenants).where(eq(tenants.country, "EG"));

  for (const tenant of egTenants) {
    // THE TENANT GATE, hoisted above both the sweep and the claim. An
    // unconfigured or not-yet-activated tenant is not a failure — it is a
    // tenant part-way through ETA onboarding — and there is nothing useful to
    // do for one: no document may be submitted, and claiming its rows would
    // only push their backoff clocks out by a lease each pass, churning a queue
    // nobody can drain. One query, no rows claimed, no lease churn.
    //
    // Deliberately covers the reconciliation sweep too: enqueueing rows we then
    // cannot finalize would log an EtaConfigError per order per pass. Nothing
    // is lost by waiting — the sweep has no upper age bound, so the moment the
    // tenant activates it adopts every order it skipped.
    if ((await resolveEtaConfig(tenant.id)) === null) {
      result.skippedTenants++;
      continue;
    }

    const provider = opts.provider ?? resolveFiscalProvider(tenant);

    if (opts.reconcile !== false) {
      const swept = await reconcileMissingReceipts({ tenantId: tenant.id }, { limit });
      result.reconciled += swept.enqueued;
    }

    for (const row of await claim(tenant.id, limit)) {
      const outcome = await processRow(tenant.id, row, provider, now);
      result.processed++;
      if (outcome === "submitted") result.submitted++;
      else if (outcome === "accepted") result.accepted++;
      else if (outcome === "rejected") result.rejected++;
      else if (outcome === "failed") result.failed++;
      else result.deferred++;
    }
  }

  return result;
}

/**
 * Claims up to `limit` eligible rows by pushing their backoff clock out by the
 * lease, so a concurrent drain's own claim cannot see them.
 *
 * `submitted` rows are claimed alongside `pending`/`failed`: submission is a
 * 202 "accepted for processing", and the verdict only arrives from the poll
 * phase (addendum §3), so a submitted row is not finished — it is waiting.
 *
 * Only receipt docTypes. B2B `e_invoice`/`credit_note` are deferred with their
 * trigger and nothing enqueues them; their uuid is ETA-assigned rather than
 * self-computed, so the finalize step does not apply to them at all. Filtering
 * here means such a row (if one were ever hand-written) sits inert instead of
 * failing loudly on every pass.
 */
async function claim(tenantId: string, limit: number): Promise<ClaimedRow[]> {
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<ClaimedRow>(sql`
      UPDATE eta_submissions
         SET next_attempt_at = now() + make_interval(secs => ${CLAIM_LEASE_MS / 1000})
       WHERE id IN (
         SELECT id FROM eta_submissions
          WHERE status IN ('pending', 'failed', 'submitted')
            AND doc_type IN ('e_receipt', 'return_receipt')
            AND next_attempt_at <= now()
            AND attempts < ${MAX_ATTEMPTS}
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
       )
      RETURNING id, doc_type AS "docType", status, attempts, submission_uuid AS "submissionUuid"
    `);
    return rows;
  });
}

type RowOutcome = "submitted" | "accepted" | "rejected" | "failed" | "deferred";

/**
 * One row, end to end.
 *
 * FINALIZE FIRST, always — including for a row that already carries its uuid,
 * because that call is also what resolves which device's credential submits
 * it. A row reaching the worker unfinalized is the normal fallback path (the
 * sale-path finalization is best-effort), not an error.
 */
async function processRow(
  tenantId: string, row: ClaimedRow, provider: FiscalProvider, now: () => Date,
): Promise<RowOutcome> {
  try {
    // The tenant-level gate ran once for the whole tenant before this row was
    // claimed (see drainEtaSubmissions); only the DEVICE credential is
    // per-row, because which device submits depends on the document.
    const finalized = await finalizeSubmissionRow(tenantId, row.id);
    if (finalized.status === "deferred") return "deferred";

    // The DEVICE credential, not the ERP one: e-receipts authenticate per POS
    // device (addendum C6). Null means the device is registered but not usable
    // (`resolveEtaConfig` accepts `"active"` only) — same durable skip.
    const cfg = await resolveEtaConfig(tenantId, finalized.deviceId);
    if (cfg === null) return "deferred";

    // THE IDEMPOTENCY GUARD, and it keys on `submissionUuid` rather than on
    // `status === "submitted"` deliberately. A row can be `failed` and still
    // hold a submissionUuid — that is exactly what a poll that hit a transport
    // error leaves behind — and re-submitting one of those would file a second
    // copy of a document ETA already holds, since its duplicate-detection
    // window is only ~10 minutes. Once ETA has given us a handle, we only ever
    // ask it what happened.
    return row.submissionUuid
      ? await pollPhase(tenantId, row, provider, cfg, now)
      : await submitPhase(tenantId, row, provider, cfg, now);
  } catch (err) {
    return handleFailure(tenantId, row, err, now);
  }
}

/**
 * The wire document + identity as PERSISTED, re-read after finalization so
 * what is submitted is byte-for-byte what was hashed.
 *
 * `request_json::text`, not the mapped column: node-postgres would `JSON.parse`
 * it and collapse `114.00` to `114`, and ETA re-derives the uuid from the bytes
 * it receives. The text comes back exactly as written (the column is `json`,
 * which Postgres stores verbatim) and `parseWire` restores the decimals.
 *
 * Re-reading rather than rebuilding is deliberate: an issued document's bytes
 * are fixed at issuance, and rebuilding would silently follow later edits to
 * the tenant's tax codes, wire context, or even the sale's tenders (`addTender`
 * on a partially-paid sale changes `paymentMethod`) — producing a document that
 * no longer hashes to the uuid already printed on the customer's receipt.
 */
async function loadFinalized(tenantId: string, submissionId: string): Promise<FinalizedFiscalDocument> {
  const [stored] = await withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<{ docType: EtaDocType; wire: string; uuid: string | null; qrUrl: string | null }>(sql`
      SELECT doc_type AS "docType", request_json::text AS wire, eta_uuid AS "uuid", qr_payload AS "qrUrl"
        FROM eta_submissions
       WHERE tenant_id = ${tenantId} AND id = ${submissionId}
       LIMIT 1
    `);
    return rows;
  });

  if (!stored?.uuid) throw new Error(`fiscal: submission ${submissionId} has no etaUuid after finalization`);
  return { docType: stored.docType, wire: parseWire(stored.wire), uuid: stored.uuid, qrUrl: stored.qrUrl ?? "" };
}

async function submitPhase(
  tenantId: string, row: ClaimedRow, provider: FiscalProvider, cfg: EtaConfig, now: () => Date,
): Promise<RowOutcome> {
  const finalized = await loadFinalized(tenantId, row.id);
  const result = await provider.submit(finalized, cfg);

  // The plan asked for `submissionUuid` + `submitted` to be written BEFORE the
  // network call resolved, for crash safety. That ordering is not achievable:
  // the submissionUUID only exists in ETA's 202 response. The crash window is
  // instead closed from the other side — `submit` throws on a 202 it cannot
  // parse, and the retry is idempotent inside ETA's duplicate window; see
  // MAX_ATTEMPTS above and the long note on that throw in `eta-provider.ts`.
  if (result.status === "rejected") return persistRejected(tenantId, row, result, now);
  if (result.status === "accepted") return persistAccepted(tenantId, row, result, now);
  if (result.status !== "submitted") return "deferred"; // "skipped" — a no-op provider wrote nothing.

  await withTenant(tenantId, async (tx) => {
    await tx.update(etaSubmissions).set({
      status: "submitted",
      submissionUuid: result.submissionUuid ?? null,
      submittedAt: now(),
      responseJson: result.responseJson,
      lastError: null,
      // Not a backoff — the document is with ETA and the poll phase is simply
      // the next step, so this consumes no attempt.
      nextAttemptAt: new Date(now().getTime() + POLL_INTERVAL_MS),
    }).where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, row.id)));

    await recordFiscalAudit(auditActor(tenantId), {
      action: FISCAL_AUDIT_ACTIONS.submitted,
      entityId: row.id,
      summary: `Fiscal ${row.docType} submitted to ETA (submission ${result.submissionUuid})`,
      metadata: { docType: row.docType, submissionUuid: result.submissionUuid, etaUuid: finalized.uuid },
      actorType: "system",
    }, tx);
  });

  return "submitted"; // Not terminal: the verdict comes from a later poll.
}

/**
 * Asks ETA for a submitted document's verdict.
 *
 * `InProgress` is the expected answer for a while — ETA validates
 * asynchronously — so it is NOT a failure: the clock moves on by one poll
 * interval and `attempts` is untouched. Only a genuine transport failure
 * consumes an attempt, which does mean a submitted row can poll indefinitely
 * if ETA never finishes; surfacing that (against the 24-hour submission
 * window) is the fiscal dashboard's job, not a reason to fail a document ETA
 * may still accept.
 */
async function pollPhase(
  tenantId: string, row: ClaimedRow, provider: FiscalProvider, cfg: EtaConfig, now: () => Date,
): Promise<RowOutcome> {
  const result = await provider.poll(row.submissionUuid!, cfg);

  if (result.status === "accepted") return persistAccepted(tenantId, row, result, now);
  if (result.status === "rejected") return persistRejected(tenantId, row, result, now);

  if (result.status === "submitted") {
    await withTenant(tenantId, (tx) =>
      tx.update(etaSubmissions)
        .set({
          // Corrective, not decorative: a row that reached the poll phase and
          // then hit a transport error was left `failed`, and it is not — the
          // document is with ETA. A successful poll is the moment to say so.
          status: "submitted",
          responseJson: result.responseJson,
          nextAttemptAt: new Date(now().getTime() + POLL_INTERVAL_MS),
        })
        .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, row.id))));
  }
  return "deferred";
}

async function persistAccepted(
  tenantId: string, row: ClaimedRow, result: FiscalSubmitResult, now: () => Date,
): Promise<RowOutcome> {
  await withTenant(tenantId, async (tx) => {
    await tx.update(etaSubmissions).set({
      status: "accepted",
      acceptedAt: now(),
      // ETA's own identifier for the accepted document; ours (etaUuid) was
      // written at finalization and never changes.
      ...(result.etaLongId ? { etaLongId: result.etaLongId } : {}),
      ...(result.submissionUuid ? { submissionUuid: result.submissionUuid } : {}),
      responseJson: result.responseJson,
      lastError: null,
    }).where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, row.id)));

    await recordFiscalAudit(auditActor(tenantId), {
      action: FISCAL_AUDIT_ACTIONS.accepted,
      entityId: row.id,
      summary: `Fiscal ${row.docType} accepted by ETA`,
      metadata: { docType: row.docType, etaLongId: result.etaLongId ?? null },
      actorType: "system",
    }, tx);
  });
  return "accepted";
}

/**
 * ETA looked at the document and refused it. Terminal for THIS row: a
 * correction is a new document with a new uuid carrying `referenceOldUUID`
 * (addendum C3) — `enqueueCorrectedResubmission`, triggered from the fiscal
 * dashboard, never automatically from here. Retrying the identical bytes would
 * only be refused identically.
 *
 * `attempts` is left where it is rather than pushed to the cap: `rejected` is
 * outside the claim query's status filter, so the row is already unreachable,
 * and preserving the real count keeps the row honest about how many times it
 * was tried.
 */
async function persistRejected(
  tenantId: string, row: ClaimedRow, result: FiscalSubmitResult, now: () => Date,
): Promise<RowOutcome> {
  const detail = describeRejection(result.responseJson);
  await withTenant(tenantId, async (tx) => {
    await tx.update(etaSubmissions).set({
      status: "rejected",
      responseJson: result.responseJson,
      lastError: `rejected: ${detail}`,
      ...(result.submissionUuid ? { submissionUuid: result.submissionUuid } : {}),
      // Clears the claim lease. A terminal row waits for nothing, and leaving a
      // future clock on it would read as "retrying shortly" on the dashboard.
      nextAttemptAt: now(),
    }).where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, row.id)));

    await recordFiscalAudit(auditActor(tenantId), {
      action: FISCAL_AUDIT_ACTIONS.rejected,
      entityId: row.id,
      summary: `Fiscal ${row.docType} rejected by ETA`,
      metadata: { docType: row.docType, detail },
      actorType: "system",
    }, tx);

    await notifyFiscalFailure({ tenantId }, {
      title: "A fiscal document was rejected by ETA",
      body: `The ${row.docType.replace("_", " ")} for this sale was rejected: ${detail}. The sale itself stands — ` +
        "correct the underlying data and resubmit a corrected document from the fiscal dashboard.",
      entityType: "eta_submission",
      entityId: row.id,
      targets: [{ role: "owner" }],
      channels: ["in_app"],
    }, tx);
  });
  return "rejected";
}

/**
 * The FAILURE TAXONOMY (`./provider`), applied. Three families, three
 * behaviours:
 *
 *   FiscalDocumentError  permanent, a DATA fix ("this product has no tax code")
 *   EtaConfigError       permanent, a SETUP fix ("finish ETA setup")
 *   EtaTransportError    retryable — except the three codes that cannot
 *                        self-heal (see PERMANENT_ETA_ERROR_CODES)
 *
 * Anything else is unrecognised, and an unrecognised failure is treated as
 * RETRYABLE: giving up permanently on an error nobody has classified would
 * drop a fiscal document on the strength of a guess, whereas retrying it costs
 * at most six attempts and then alerts anyway.
 */
async function handleFailure(tenantId: string, row: ClaimedRow, err: unknown, now: () => Date): Promise<RowOutcome> {
  if (err instanceof FiscalDocumentError) {
    return failPermanently(tenantId, row, `${err.code}: ${err.message}`, now,
      "This sale cannot be turned into a valid ETA document until its data is corrected.");
  }
  if (err instanceof EtaConfigError) {
    return failPermanently(tenantId, row, `${err.code}: ${err.message}`, now,
      "ETA configuration is incomplete, so this document cannot be submitted. Finish fiscal setup.");
  }
  if (err instanceof EtaTransportError && err.etaErrorCode && PERMANENT_ETA_ERROR_CODES.has(err.etaErrorCode)) {
    return failPermanently(tenantId, row, `${err.code}/${err.etaErrorCode}: ${err.message}`, now,
      "ETA refused the submission for a reason that cannot resolve on a retry.");
  }
  return failTransiently(tenantId, row, err, now);
}

/**
 * No backoff, no further attempts — `attempts` is pushed to the cap so the
 * claim query can never reach this row again, which is also what makes the
 * alert fire exactly once.
 */
async function failPermanently(
  tenantId: string, row: ClaimedRow, lastError: string, now: () => Date, guidance: string,
): Promise<RowOutcome> {
  await withTenant(tenantId, async (tx) => {
    // `attempts < MAX_ATTEMPTS` makes this write the thing that DECIDES who
    // alerts. Two drains can hold one row at once — the claim lease can expire
    // mid-flight, which is a documented and accepted window — and without this
    // predicate both would terminalize it and both would notify. The first
    // UPDATE parks attempts at the cap; the second matches nothing, returns no
    // row, and stays quiet. One terminal failure, one alert.
    const terminalized = await tx.update(etaSubmissions)
      // nextAttemptAt clears the claim lease — see persistRejected.
      .set({ status: "failed", attempts: MAX_ATTEMPTS, lastError, nextAttemptAt: now() })
      .where(and(
        eq(etaSubmissions.tenantId, tenantId),
        eq(etaSubmissions.id, row.id),
        lt(etaSubmissions.attempts, MAX_ATTEMPTS),
      ))
      .returning({ id: etaSubmissions.id });

    if (terminalized.length === 0) return;

    await notifyFiscalFailure({ tenantId }, {
      title: "A fiscal document could not be submitted",
      body: `${guidance} Last error: ${lastError}`,
      entityType: "eta_submission",
      entityId: row.id,
      targets: [{ role: "owner" }],
      channels: ["in_app"],
    }, tx);
  });
  return "failed";
}

/** `attempts++` and back off, honouring ETA's `Retry-After` as a FLOOR
 *  (APIs Governance: the wait "should be larger then the value returned").
 *  The alert fires on the attempt that reaches the cap — once, because the
 *  claim query then excludes the row. */
async function failTransiently(tenantId: string, row: ClaimedRow, err: unknown, now: () => Date): Promise<RowOutcome> {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const retryAfterMs = err instanceof EtaTransportError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
  const backoffMs = Math.max(2 ** attempts * BACKOFF_BASE_MS, retryAfterMs);
  const lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);

  await withTenant(tenantId, async (tx) => {
    // Compare-and-set on the attempt count we READ at claim time. Two drains
    // holding one row (an expired lease) must not both increment it, and at the
    // cap they must not both alert: whichever writes first moves `attempts` off
    // the value both read, so the loser's UPDATE matches nothing. Stronger than
    // guarding the notify alone — it makes the counter itself race-safe, so
    // "failed 6 times" means six real attempts.
    const advanced = await tx.update(etaSubmissions).set({
      status: "failed", attempts, lastError,
      nextAttemptAt: new Date(now().getTime() + backoffMs),
    }).where(and(
      eq(etaSubmissions.tenantId, tenantId),
      eq(etaSubmissions.id, row.id),
      eq(etaSubmissions.attempts, row.attempts),
    )).returning({ id: etaSubmissions.id });

    if (exhausted && advanced.length > 0) {
      await notifyFiscalFailure({ tenantId }, {
        title: "A fiscal document could not be submitted",
        body: `Submission to ETA failed ${MAX_ATTEMPTS} times and will not be retried automatically. Last error: ${lastError}`,
        entityType: "eta_submission",
        entityId: row.id,
        targets: [{ role: "owner" }],
        channels: ["in_app"],
      }, tx);
    }
  });
  return "failed";
}

/**
 * The actor half of every audit event this worker writes: no user, no device —
 * a scheduled drain is a system action (F8: submission carries no RBAC grant).
 *
 * Only the CONTEXT is factored out. Each writer calls `recordFiscalAudit`
 * itself rather than going through a local wrapper, so the emission is visible
 * where the write is — to a reader, to grep, and to the audit-coverage
 * guardrail, whose whole method is looking for that call inside a function
 * that writes.
 */
function auditActor(tenantId: string): AuditContext {
  return { tenantId, actorUserId: null, fingerprint: emptyFingerprint() };
}

/**
 * A short, human-readable reason out of ETA's rejection body, for `lastError`
 * and the owner's alert. The full body is always kept in `responseJson`
 * (already redacted by the transport layer) — this is the headline, not a
 * replacement for it.
 */
function describeRejection(responseJson: Record<string, unknown>): string {
  const rejected = responseJson.rejectedDocuments;
  const first = Array.isArray(rejected) ? rejected[0] : null;
  const error = first && typeof first === "object" ? (first as Record<string, unknown>).error : null;
  if (error && typeof error === "object") {
    const { code, message } = error as Record<string, unknown>;
    if (typeof message === "string") return typeof code === "string" ? `${code}: ${message}` : message;
  }
  const status = responseJson.status;
  return typeof status === "string" ? status : "ETA refused the document (see responseJson)";
}
