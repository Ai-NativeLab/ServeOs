import { and, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
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
import { FiscalDocumentError, redactedErrorSummary } from "./errors";
import { EtaConfigError, EtaTransportError } from "./eta-transport-errors";
import type { EmailProvider } from "@/server/email/provider";
import { FISCAL_AUDIT_ACTIONS, recordFiscalAudit, notifyFiscalFailure } from "./effects";
import { SUBMISSION_MAX_ATTEMPTS, SUBMISSION_WINDOW_MS, isReceiptSubmissionWindowFamily } from "./constants";
import { deliverFiscalDocumentEmail } from "./customer-email";
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
 * The attempt cap. Six retries on the schedule below span ~31 minutes (the 6th backoff is written but never served — the claim excludes attempts >= MAX_ATTEMPTS)
 * of transient failure before a row is parked for a human.
 *
 * A retry of a POST that MAY have reached ETA (a timeout after the send, a 202
 * with no submissionUUID) is not left to ETA's ~10-minute payload dedupe, which
 * every backoff past the first outlives: `markDispatched` stamps `submitted_at`
 * before the request leaves, and a receipt carrying that stamp is looked up by
 * its uuid before it is re-sent (`submitPhase`). A duplicate refusal is settled
 * from ETA's record, never as a rejection. Invoices have no uuid to look up and
 * still lean on the dedupe — see the note on the invoice-path throw.
 *
 * ONLY SUBMISSION failures count. A row ETA already holds (it has a
 * submissionUuid) never spends an attempt on a failed poll — see
 * `failTransiently`.
 */
export const MAX_ATTEMPTS = SUBMISSION_MAX_ATTEMPTS;

/** Same base and shape as the notifications outbox: `2 ** attempts * base`. */
const BACKOFF_BASE_MS = 30 * 1000;

/** How long to wait before re-polling a submission ETA is still processing.
 *  Not a backoff — nothing failed — so it does not grow and does not consume
 *  an attempt. */
const POLL_INTERVAL_MS = 60 * 1000;

/** How long a row ETA already holds waits after a FAILED poll. Fixed rather
 *  than exponential because it consumes no attempt (see `failTransiently`):
 *  long enough not to hammer an ETA that is down, short enough that a verdict
 *  is picked up within a few cron ticks of ETA recovering. */
const POLL_RETRY_BACKOFF_MS = 5 * 60 * 1000;

// ETA's 24-hour submission window lives in `./constants` as
// `SUBMISSION_WINDOW_MS` rather than here, even though the retry arithmetic
// above is sized against it and this module now reads it (see
// `noteLateSubmission`): `read-model.ts` needs the same number to flag overdue
// documents, and importing THIS module for it dragged the ETA HTTP client and
// the whole provider graph into every dashboard page and POS route. The
// dependency runs worker -> constants <- read-model, never worker <-> read-model.
// The arithmetic that keeps ordinary retries inside the window is documented on
// the constant itself.


/**
 * THE DRAIN BUDGET, stated rather than left to be discovered.
 *
 * One pass claims at most `limit` (default 20) rows per tenant, and a document
 * needs two passes to reach a verdict — one to submit, one to poll. On the
 * 15-minute cron this task registers, that is
 *
 *     20 rows/pass x 96 passes/day / 2 passes per document
 *       ~= 960 documents per tenant per day
 *
 * comfortably above a single restaurant's volume and comfortably inside the
 * 24-hour window above. A tenant that genuinely exceeds it needs a larger
 * `limit` or a tighter schedule, not a code change.
 *
 * THE OTHER EDGE — wall-clock, not throughput. Each row can hold the pass for
 * up to `ETA_HTTP_TIMEOUT_MS` (60s) if ETA stops answering, so a full batch of
 * 20 stalled rows would want 20 minutes and will instead be killed by whatever
 * serverless execution budget the deployment has. That is survivable BY DESIGN
 * rather than by luck: a killed pass leaves its claimed rows leased, the lease
 * expires, and the next pass picks them up exactly where this one stopped. It
 * is said out loud here because "the worker sometimes gets killed" should be a
 * known property, not a mystery in the logs.
 */

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
 * one sale. There is no cheap way to unfile one. (For a receipt the dispatch
 * stamp + lookup in `submitPhase` is a second line; for an invoice it is the
 * only one.)
 *
 * THE LEASE IS ALSO A FENCING TOKEN. The claim returns the `next_attempt_at` it
 * wrote, and every write the drain makes requires the row to still carry it
 * (`heldBy`), so the drain that LOST the lease cannot write over the one that
 * re-claimed the row — no re-submit, no accepted -> rejected regression.
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
  /**
   * When ServeOS wrote the row — the clock the late check runs on. See
   * `noteLateSubmission` for how far it can trail `dateTimeIssued`.
   *
   * A STRING, NOT A `Date`, AND THAT IS THE DRIVER RATHER THAN A CHOICE. This
   * row comes back from `tx.execute` — raw SQL, because the claim is an
   * `UPDATE … RETURNING` no query builder expresses — and drizzle's raw path
   * hands `timestamptz` back as the wire text (measured: `typeof === "string"`,
   * not a `Date`). Column codecs only run on the mapped `select()` path. Typed
   * honestly here so the one place that needs a moment has to say `new Date(…)`,
   * rather than a `Date` annotation that lies and throws at the call site.
   */
  createdAt: string;
  /** Read only to SKIP a write that would match nothing — the UPDATE's own
   *  `IS NULL` predicate is what decides. Same raw-path caveat as `createdAt`;
   *  never parsed, only tested for presence. */
  lateNotifiedAt: string | null;
  /** The self-computed uuid, when the row was already finalized at claim time.
   *  Read by the poll phase's already-filed check; never trusted for submit,
   *  which re-reads the persisted document. */
  etaUuid: string | null;
  /**
   * When a submission POST for this row was last DISPATCHED — written before the
   * request leaves (see `markDispatched`). With `submissionUuid` still null it
   * means "this document MAY be with ETA": a timeout after the send, or a 202
   * that carried no submissionUUID. Same raw-path caveat as `createdAt`.
   */
  submittedAt: string | null;
  /**
   * THE LEASE TOKEN: the `next_attempt_at` this drain's claim wrote, as the
   * database's own text (microseconds intact — a JS `Date` would truncate them
   * and never compare equal). Every write this drain makes to the row requires
   * the row to still carry it, so a drain whose lease expired and whose row was
   * re-claimed by another pass matches nothing — see `heldBy`.
   */
  leaseUntil: string;
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
  /**
   * The email provider the customer's fiscal-document copy is sent through.
   * Injectable for exactly the reason `provider` above is: so a test drives the
   * REAL worker and inspects what was composed, rather than asserting against
   * `process.env.EMAIL_PROVIDER`. Defaults to `activeEmailProvider()`, resolved
   * inside `deliverFiscalDocumentEmail` so a drain that emails nobody never
   * constructs one.
   */
  emailProvider?: EmailProvider;
  /** The whole pass's wall-clock budget — see `DRAIN_BUDGET_MS`. */
  budgetMs?: number;
  /** One tenant's share of it — see `TENANT_BUDGET_MS`. */
  tenantBudgetMs?: number;
  /** Elapsed-time clock for the two budgets, in ms. Separate from `now`, which
   *  stamps rows and which tests freeze. */
  clockMs?: () => number;
};

/**
 * THE PASS BUDGET. The route that runs this declares `maxDuration = 300`
 * (`/api/fiscal/worker`); the pass stops STARTING work at 240s so the one call
 * that may be in flight — up to `ETA_HTTP_TIMEOUT_MS` (60s) — still finishes
 * inside the platform's limit instead of being killed mid-write. Rows not reached
 * are released (`releaseUnprocessed`), never stranded behind a lease.
 */
export const DRAIN_BUDGET_MS = 240_000;

/**
 * ONE TENANT'S SHARE. Without it a single tenant with a slow ETA (each call can
 * hang for the full 60s timeout) would spend the whole pass on its own 20 rows
 * and every tenant after it in the list would wait — on every pass, since the
 * order used to be fixed. With it, a stalled tenant costs at most this much, and
 * the rotation in `rotateTenants` means the tenant that went last this pass goes
 * earlier next time.
 */
export const TENANT_BUDGET_MS = 60_000;

/** How often the tenant order rotates by one place: the cron cadence. */
const ROTATION_BUCKET_MS = 15 * 60 * 1000;

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
  /** Claimed rows handed back unprocessed because a budget ran out — eligible
   *  again immediately, picked up by the next pass. */
  released: number;
  /** EG tenants not reached at all this pass because the pass budget ran out.
   *  The rotation puts them earlier next pass. */
  unvisitedTenants: number;
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
  const clockMs = opts.clockMs ?? (() => Date.now());
  const budgetMs = opts.budgetMs ?? DRAIN_BUDGET_MS;
  const tenantBudgetMs = opts.tenantBudgetMs ?? TENANT_BUDGET_MS;
  const startedAt = clockMs();
  const result: DrainResult = {
    processed: 0, submitted: 0, accepted: 0, rejected: 0, failed: 0, deferred: 0, reconciled: 0, skippedTenants: 0,
    released: 0, unvisitedTenants: 0,
  };

  const egTenants = rotateTenants(
    await db.select({ id: tenants.id, country: tenants.country })
      .from(tenants).where(eq(tenants.country, "EG")).orderBy(tenants.id),
    now(),
  );

  for (const [index, tenant] of egTenants.entries()) {
    // The PASS budget, checked before a tenant is started — never before the
    // first, so every pass makes progress however small the budget.
    if (index > 0 && clockMs() - startedAt >= budgetMs) {
      result.unvisitedTenants = egTenants.length - index;
      break;
    }
    const tenantStartedAt = clockMs();

    // THE TENANT GATE, hoisted above both the sweep and the claim. An
    // unconfigured or not-yet-activated tenant is not a failure — it is a
    // tenant part-way through ETA onboarding — and there is nothing useful to
    // do for one: no document may be submitted, and claiming its rows would
    // only push their backoff clocks out by a lease each pass, churning a queue
    // nobody can drain. One query, no rows claimed, no lease churn.
    //
    // Deliberately covers the reconciliation sweep too: enqueueing rows we then
    // cannot finalize would log an EtaConfigError per order per pass. Sales
    // from BEFORE activation are deliberately not adopted later either — the
    // sweep is floored at the activation (see `reconcileMissingReceipts`).
    if ((await resolveEtaConfig(tenant.id)) === null) {
      result.skippedTenants++;
      continue;
    }

    const provider = opts.provider ?? resolveFiscalProvider(tenant);

    if (opts.reconcile !== false) {
      const swept = await reconcileMissingReceipts({ tenantId: tenant.id }, { limit });
      result.reconciled += swept.enqueued;
    }

    const claimed = await claim(tenant.id, limit);
    for (const [rowIndex, row] of claimed.entries()) {
      // THE BUDGETS, per row: this tenant's share and the pass as a whole. The
      // first row of a tenant always runs, so a tenant reached is a tenant that
      // moves. Rows not reached are released rather than left to sit out the
      // lease.
      const elapsedAt = clockMs();
      if (rowIndex > 0 && (elapsedAt - tenantStartedAt >= tenantBudgetMs || elapsedAt - startedAt >= budgetMs)) {
        result.released += await releaseUnprocessed(tenant.id, claimed.slice(rowIndex));
        break;
      }
      // BEFORE the row is driven, and OUTSIDE `processRow`'s try/catch, which is
      // the whole placement argument — see `noteLateSubmission`. Whatever it
      // does or fails to do, the row is submitted next exactly as it would have
      // been.
      await noteLateSubmission(tenant.id, row, now);
      const outcome = await processRow(tenant.id, row, provider, now, opts.emailProvider);
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
 * The EG tenants in this pass's order: the stable id order, rotated by one place
 * per cron tick (`ROTATION_BUCKET_MS`). A fixed order meant the same tenants
 * always went last and were always the ones a budget cut off; rotating spreads
 * that across every tenant in turn. Deterministic in `now`, so a test can drive
 * two consecutive ticks and see the order move.
 */
function rotateTenants<T>(ordered: T[], at: Date): T[] {
  if (ordered.length < 2) return ordered;
  const offset = Math.floor(at.getTime() / ROTATION_BUCKET_MS) % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)];
}

/**
 * Hands claimed-but-unprocessed rows back: their lease is cleared to now(), so
 * the next pass can claim them at once instead of waiting `CLAIM_LEASE_MS`.
 * Fenced on each row's own lease, so a row that has since been re-claimed or
 * written is left alone.
 */
async function releaseUnprocessed(tenantId: string, rows: ClaimedRow[]): Promise<number> {
  let released = 0;
  await withTenant(tenantId, async (tx) => {
    for (const row of rows) {
      const back = await tx.update(etaSubmissions)
        .set({ nextAttemptAt: sql`now()` })
        .where(heldBy(tenantId, row, LIVE_STATUSES))
        .returning({ id: etaSubmissions.id });
      released += back.length;
    }
  });
  return released;
}

/**
 * Claims up to `limit` eligible rows by pushing their backoff clock out by the
 * lease, so a concurrent drain's own claim cannot see them.
 *
 * `submitted` rows are claimed alongside `pending`/`failed`: submission is a
 * 202 "accepted for processing", and the verdict only arrives from the poll
 * phase (addendum §3), so a submitted row is not finished — it is waiting.
 *
 * THREE docTypes, not four. `e_invoice` joined the receipt pair in round 2 Task
 * 3 — it has a builder, a wire mapper and an ERP submission path — while
 * `credit_note`, the B2B CORRECTION document, is still deferred and nothing
 * enqueues one. Filtering here means such a row (if one were ever hand-written)
 * sits inert instead of failing loudly on every pass.
 *
 * THE ORDER OF THE RETURNED ROWS IS UNSPECIFIED, AND NOTHING MAY RELY ON IT.
 * The `ORDER BY next_attempt_at` belongs to the SUBQUERY — it decides WHICH rows
 * are selected when more are eligible than `limit`, which is the property worth
 * having (oldest-eligible first, so a backlog drains in issuance order). It does
 * NOT order the outer `RETURNING`: SQL gives an UPDATE's returned rows no
 * ordering guarantee, and the planner is free to emit them in whatever order the
 * update touched them. Ties make it visible fastest — several rows sharing one
 * `next_attempt_at` can come back in any order at all — and an index change
 * elsewhere is enough to flip it (Task 9's `(tenant_id, created_at)` index did
 * exactly that).
 *
 * SO THE DRIVE LOOP MUST BE ORDER-INDEPENDENT, and it is: every row is processed
 * in its own transaction and decides for itself. A return receipt whose parent
 * is not yet accepted defers and costs no attempt, whether the parent was driven
 * a microsecond ago in this pass or has not been claimed yet — the check reads
 * the parent's committed status, not this loop's position. If a future change
 * ever needs a guaranteed order (a batch that must submit parents before
 * children, say), it must sort the claimed rows in code or claim them in
 * separate queries; adding an ORDER BY to this statement would not do it.
 */
async function claim(tenantId: string, limit: number): Promise<ClaimedRow[]> {
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.execute<ClaimedRow>(sql`
      UPDATE eta_submissions
         SET next_attempt_at = now() + make_interval(secs => ${CLAIM_LEASE_MS / 1000})
       WHERE id IN (
         SELECT id FROM eta_submissions
          WHERE status IN ('pending', 'failed', 'submitted')
            AND doc_type IN ('e_receipt', 'return_receipt', 'e_invoice')
            AND next_attempt_at <= now()
            AND attempts < ${MAX_ATTEMPTS}
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
       )
      RETURNING id, doc_type AS "docType", status, attempts, submission_uuid AS "submissionUuid",
                created_at AS "createdAt", late_notified_at AS "lateNotifiedAt",
                eta_uuid AS "etaUuid", submitted_at AS "submittedAt",
                next_attempt_at::text AS "leaseUntil"
    `);
    return rows;
  });
}

/**
 * THE LATE-WINDOW STATE: notice it, say so once, and submit it anyway.
 *
 * ETA gives a receipt 24 hours from issuance ("The receipt is allowed to be
 * submitted within the allowed duration (24 hours)…", Receipt Issuance FAQ,
 * quoted in full on `SUBMISSION_WINDOW_MS`). Past it the document is not
 * forbidden, it is LATE: ETA's own remedy is a **Late Submission Request** —
 * "Late Submission Window (Days) - Sets the maximum age of documents that will
 * be accepted by a Late Submission Request" — a portal action, performed by a
 * taxpayer representative against a yearly quota, that nothing in this pipeline
 * can perform on the owner's behalf.
 *
 * SO THE WORKER STILL SUBMITS. That is the addendum §3 stance restated where it
 * bites: "the budget is respected by arithmetic … and the breach is FLAGGED AT
 * THE READ LAYER, not enforced at the worker — stopping retries at the deadline
 * would turn a late document into no document." Refusing at hour 25 would
 * guarantee the outcome the deadline exists to prevent — an undeclared sale —
 * and would do it on our own authority, since ETA has not refused anything. The
 * only thing that changes past the window is that the owner gets told.
 *
 * ONCE, AND THE UPDATE IS THE ARBITER. `late_notified_at IS NULL` in the WHERE
 * clause, notify only if a row came back — the same shape `failPermanently` uses
 * for its own alert, and for the same reason: two drains can hold one row at
 * once when a claim lease expires mid-flight (`CLAIM_LEASE_MS`), and a
 * read-then-write would send one document's alert twice. `row.lateNotifiedAt` is
 * consulted first only to skip a write that would match nothing — every already
 * flagged row, i.e. every pass after the first — and never to decide.
 *
 * IT CONSUMES NO ATTEMPT AND CANNOT FAIL THE ROW. `attempts` is the retry budget
 * for talking to ETA; noticing a date is not an attempt at anything, and
 * charging one would mean a document parked for a human sooner because it was
 * late — punishing the row for the condition being reported. It also runs
 * OUTSIDE `processRow`'s try/catch, so its own failure cannot be mistaken for a
 * submission failure by `handleFailure`: a throw here would otherwise be
 * classified as unrecognised, back the row off and eventually terminalize it,
 * which would turn a notification bug into an unfiled tax document. A failure is
 * logged and the pass continues; the flag is unset, so the next pass retries it.
 *
 * WHY AT CLAIM TIME. Only a claimed row is one the worker is about to act on,
 * and the claim query has already filtered to `pending`/`failed`/`submitted` —
 * every non-terminal status and nothing else. So "non-terminal" needs no second
 * check here: an `accepted` or `rejected` row is never claimed, and therefore
 * never flagged. That is the intended reading and not an omission — a rejected
 * document has nothing left to submit late, and an accepted one made it.
 *
 * RECEIPT FAMILY ONLY (`isReceiptSubmissionWindowFamily`). No ETA SDK page
 * publishes a submission deadline for invoice v1.0 — checked page by page, see
 * the constant — so an `e_invoice` is never flagged. VERIFY-13.
 *
 * THE CLOCK IS `created_at`, WHICH CAN TRAIL `dateTimeIssued`. For a POS sale
 * the two are seconds apart. For an order adopted by `reconcileMissingReceipts`
 * — the online channel's normal path — the row is written when the sweep found
 * it, so an order placed six days ago is flagged only 24 hours after ADOPTION,
 * not 24 hours after issuance. Bounded by the sweep horizon (7 days) and
 * accepted: the alternative is reading `dateTimeIssued` out of `request_json`
 * for every claimed row on every pass, to sharpen the timing of an alert about
 * a document whose real problem is that nothing filed it for six days.
 */
async function noteLateSubmission(tenantId: string, row: ClaimedRow, now: () => Date): Promise<void> {
  if (row.lateNotifiedAt) return;
  if (!isReceiptSubmissionWindowFamily(row.docType)) return;
  if (now().getTime() - new Date(row.createdAt).getTime() <= SUBMISSION_WINDOW_MS) return;

  try {
    await withTenant(tenantId, async (tx) => {
      const flagged = await tx.update(etaSubmissions)
        .set({ lateNotifiedAt: now() })
        .where(and(
          eq(etaSubmissions.tenantId, tenantId),
          eq(etaSubmissions.id, row.id),
          isNull(etaSubmissions.lateNotifiedAt),
        ))
        .returning({ id: etaSubmissions.id });

      if (flagged.length === 0) return;

      await notifyFiscalFailure({ tenantId }, {
        title: "A fiscal document is past ETA's 24-hour window",
        body: "This submission is past the 24h window — a Late Submission Request may be required at the portal. " +
          "ServeOS keeps trying to submit it: the document is not abandoned, and no action here can replace the " +
          "request, which a taxpayer representative makes on ETA's portal against a yearly quota.",
        entityType: "eta_submission",
        entityId: row.id,
        targets: [{ role: "owner" }],
        channels: ["in_app"],
      }, tx);
    });
  } catch (err) {
    // The row is about to be submitted regardless — see the header. Unflagged,
    // so the next pass tries again rather than losing the alert silently.
    console.error(`[fiscal] late-window notify failed for submission ${row.id}`, err);
  }
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
  tenantId: string, row: ClaimedRow, provider: FiscalProvider, now: () => Date, emailProvider?: EmailProvider,
): Promise<RowOutcome> {
  try {
    // The tenant-level gate ran once for the whole tenant before this row was
    // claimed (see drainEtaSubmissions); only the DEVICE credential is
    // per-row, because which device submits depends on the document.
    const finalized = await finalizeSubmissionRow(tenantId, row.id);
    if (finalized.status === "deferred") return "deferred";

    // WHICH CREDENTIAL, decided by the document family and not by a flag:
    //
    //   receipt family  the DEVICE credential — e-receipts authenticate per POS
    //                   device (addendum C6), and `finalizeSubmissionRow` is
    //                   what resolved which device.
    //   e_invoice       the ERP credential — B2B documents go through Login as
    //                   Taxpayer System, and there is no device to resolve.
    //                   `resolveEtaConfig` with no device id returns a config
    //                   whose `device` is null, which is exactly what
    //                   `#submitInvoice` needs; it blanks the field again itself
    //                   so the choice cannot depend on this call site.
    //
    // Null means the tenant (or the device) is registered but not usable
    // (`resolveEtaConfig` accepts `"active"` only) — a durable skip either way.
    // Narrowed on `deviceId`'s PRESENCE rather than on the status strings: the
    // outcome variants differ precisely by whether a device was resolved, so
    // that is the honest discriminator and it is the one TypeScript can prove.
    const cfg = "deviceId" in finalized
      ? await resolveEtaConfig(tenantId, finalized.deviceId)
      : await resolveEtaConfig(tenantId);
    if (cfg === null) return "deferred";

    // THE IDEMPOTENCY GUARD, and it keys on `submissionUuid` rather than on
    // `status === "submitted"` deliberately. A row can be `failed` and still
    // hold a submissionUuid — that is exactly what a poll that hit a transport
    // error leaves behind — and re-submitting one of those would file a second
    // copy of a document ETA already holds, since its duplicate-detection
    // window is only ~10 minutes. Once ETA has given us a handle, we only ever
    // ask it what happened.
    return row.submissionUuid
      ? await pollPhase(tenantId, row, provider, cfg, now, emailProvider)
      : await submitPhase(tenantId, row, provider, cfg, now, emailProvider);
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

  if (!stored) throw new Error(`fiscal: submission ${submissionId} disappeared between finalization and submission`);
  // An `e_invoice` legitimately has no uuid here — ETA assigns it in the
  // submission response — so the receipt family's "must be hashed by now" check
  // applies only to the receipt family. Submitting an unfinalized receipt would
  // send a document whose identity nothing agrees on; submitting an invoice with
  // a null uuid is the normal path.
  if (stored.docType !== "e_invoice" && !stored.uuid) {
    throw new Error(`fiscal: submission ${submissionId} has no etaUuid after finalization`);
  }
  return { docType: stored.docType, wire: parseWire(stored.wire), uuid: stored.uuid, qrUrl: stored.qrUrl };
}

async function submitPhase(
  tenantId: string, row: ClaimedRow, provider: FiscalProvider, cfg: EtaConfig, now: () => Date,
  emailProvider?: EmailProvider,
): Promise<RowOutcome> {
  const finalized = await loadFinalized(tenantId, row.id);
  const receiptUuid = finalized.docType === "e_invoice" ? null : finalized.uuid;

  // MAYBE-SENT: an earlier POST of this row was dispatched and never answered
  // with a submissionUUID (a timeout after the send, a 202 with no handle). ETA
  // may hold the document already, and this retry is very likely OUTSIDE its
  // ~10-minute payload dedupe — so ask before re-POSTing. Receipts only: their
  // uuid is ours and deterministic, so ETA can be asked about it; an invoice's
  // uuid is ETA's and does not exist until ETA answers.
  if (receiptUuid && row.submittedAt && provider.lookupReceipt) {
    const found = await provider.lookupReceipt(receiptUuid, cfg);
    if (found) return settleFound(tenantId, row, found, receiptUuid, now, emailProvider);
  }

  // Recorded BEFORE the request leaves, because after it there may be no
  // answer to record anything against. Fenced like every other write: a row
  // another drain has moved on from is not ours to submit.
  if (!(await markDispatched(tenantId, row, now))) return "deferred";

  const result = await provider.submit(finalized, cfg);

  if (result.status === "rejected") {
    // A receipt refused as a DUPLICATE was filed — by an earlier attempt of
    // ours. Never "rejected": that would mark a document ETA holds as refused.
    if (receiptUuid && looksLikeAlreadyFiled(result.responseJson)) {
      return settleAlreadyFiled(tenantId, row, provider, cfg, receiptUuid, now, emailProvider);
    }
    return persistRejected(tenantId, row, result, now);
  }
  if (result.status === "accepted") return persistAccepted(tenantId, row, result, now, emailProvider);
  if (result.status !== "submitted") return "deferred"; // "skipped" — a no-op provider wrote nothing.

  return persistSubmitted(tenantId, row, result, finalized.uuid, now);
}

/**
 * Stamps `submitted_at` as the row's DISPATCH marker, before the POST. Returns
 * false — and the caller sends nothing — when the row is no longer this
 * drain's to submit (lease lost, status moved, or a handle already recorded).
 */
async function markDispatched(tenantId: string, row: ClaimedRow, now: () => Date): Promise<boolean> {
  const marked = await withTenant(tenantId, (tx) => tx.update(etaSubmissions)
    .set({ submittedAt: now() })
    .where(and(heldBy(tenantId, row, SUBMITTABLE), isNull(etaSubmissions.submissionUuid)))
    .returning({ id: etaSubmissions.id }));
  return marked.length > 0;
}

/**
 * The document is with ETA and has a handle: record it and wait for the poll.
 *
 * The plan asked for `submissionUuid` + `submitted` to be written BEFORE the
 * network call resolved, for crash safety. That ordering is not achievable:
 * the submissionUUID only exists in ETA's 202 response. The crash window is
 * instead closed from the other side — `markDispatched` records that a POST
 * left, and the next attempt looks the receipt up before re-sending it.
 */
async function persistSubmitted(
  tenantId: string, row: ClaimedRow, result: FiscalSubmitResult, documentUuid: string | null, now: () => Date,
): Promise<RowOutcome> {
  return withTenant(tenantId, async (tx) => {
    const written = await tx.update(etaSubmissions).set({
      status: "submitted",
      submissionUuid: result.submissionUuid ?? null,
      submittedAt: now(),
      // ETA-ASSIGNED IDENTIFIERS, WRITTEN AT SUBMISSION — the `e_invoice` path,
      // and only it. An invoice's `eta_uuid` is null until ETA answers, and its
      // answer arrives in the 202 rather than in the poll; persisting it here is
      // what stops a document that never reaches a terminal verdict from being a
      // row that cannot name what it filed. Spread conditionally so a receipt,
      // whose uuid was written at finalization and must never move, is untouched.
      ...(row.docType === "e_invoice" && result.etaUuid ? { etaUuid: result.etaUuid } : {}),
      ...(row.docType === "e_invoice" && result.etaLongId ? { etaLongId: result.etaLongId } : {}),
      responseJson: result.responseJson,
      lastError: null,
      // Not a backoff — the document is with ETA and the poll phase is simply
      // the next step, so this consumes no attempt.
      nextAttemptAt: new Date(now().getTime() + POLL_INTERVAL_MS),
    }).where(and(heldBy(tenantId, row, SUBMITTABLE), isNull(etaSubmissions.submissionUuid)))
      .returning({ id: etaSubmissions.id });

    // Another drain owns the row now (or recorded a handle first): nothing of
    // ours to audit.
    if (written.length === 0) return "deferred" as const;

    await recordFiscalAudit(auditActor(tenantId), {
      action: FISCAL_AUDIT_ACTIONS.submitted,
      entityId: row.id,
      summary: `Fiscal ${row.docType} submitted to ETA (submission ${result.submissionUuid})`,
      metadata: { docType: row.docType, submissionUuid: result.submissionUuid, etaUuid: documentUuid },
      actorType: "system",
    }, tx);
    return "submitted" as const; // Not terminal: the verdict comes from a later poll.
  });
}

/**
 * ETA answered a lookup by uuid with what it holds: settle the row on THAT
 * answer, never re-POST it. A held document with a handle but no verdict yet
 * is adopted as submitted, and the poll phase takes it from there.
 */
async function settleFound(
  tenantId: string, row: ClaimedRow, found: FiscalSubmitResult, receiptUuid: string, now: () => Date,
  emailProvider?: EmailProvider,
): Promise<RowOutcome> {
  if (found.status === "accepted") return persistAccepted(tenantId, row, found, now, emailProvider);
  if (found.status === "rejected") return persistRejected(tenantId, row, found, now);
  if (found.status === "submitted" && found.submissionUuid) {
    return persistSubmitted(tenantId, row, found, receiptUuid, now);
  }
  throw new EtaTransportError("fiscal: ETA holds this receipt but returned no verdict and no submission handle — looking it up again");
}

/**
 * ETA refused a receipt as ALREADY FILED. Look up what it holds and settle on
 * that; if it is not retrievable yet (ETA lets an issuer read a receipt back
 * only once it is valid or cancelled, so one still in validation reads as not
 * found), this is a TRANSIENT failure — the next attempt looks again, and after
 * the cap a human is told. Never a rejection.
 */
async function settleAlreadyFiled(
  tenantId: string, row: ClaimedRow, provider: FiscalProvider, cfg: EtaConfig, receiptUuid: string,
  now: () => Date, emailProvider?: EmailProvider,
): Promise<RowOutcome> {
  const found = provider.lookupReceipt ? await provider.lookupReceipt(receiptUuid, cfg) : null;
  if (found && found.status !== "rejected") return settleFound(tenantId, row, found, receiptUuid, now, emailProvider);
  throw new EtaTransportError(
    "fiscal: ETA reports this receipt as already filed, but cannot return it yet — it is not marked rejected; " +
      "the next attempt looks it up again",
  );
}

/**
 * Whether ETA's refusal says the document already EXISTS rather than that it is
 * wrong. ETA documents no per-document code for this (its 422
 * `DuplicateSubmission` is the payload-level dedupe and arrives as a transport
 * error), so this reads the error text conservatively: a false positive only
 * delays a genuine rejection by a lookup and a retry, while a false negative
 * would mark a filed receipt rejected.
 */
function looksLikeAlreadyFiled(responseJson: Record<string, unknown>): boolean {
  const texts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null) return;
    if (Array.isArray(value)) { for (const el of value) walk(el, depth + 1); return; }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "string" && /^(code|errorcode|error|message|statusreason|reason)$/i.test(key)) texts.push(child);
      else walk(child, depth + 1);
    }
  };
  walk(responseJson.rejectedDocuments ?? responseJson.receipts ?? responseJson, 0);
  return texts.some((text) => /duplicat|already\s+(been\s+)?(submitted|exists?|issued|filed|registered)/i.test(text));
}

/**
 * Asks ETA for a submitted document's verdict.
 *
 * `InProgress` is the expected answer for a while — ETA validates
 * asynchronously — so it is NOT a failure: the clock moves on by one poll
 * interval and `attempts` is untouched. Only a genuine transport failure
 * consumes an attempt, which does mean a submitted row can poll indefinitely
 * if ETA never finishes. That is deliberate — refusing a document ETA may still
 * accept would be worse — and it is not invisible: any non-accepted row past
 * `SUBMISSION_WINDOW_MS` (./constants) comes back from `listSubmissions` /
 * `getSubmissionById` with `overdue: true`, and the dashboard's submissions
 * table shows its age and marks it.
 */
async function pollPhase(
  tenantId: string, row: ClaimedRow, provider: FiscalProvider, cfg: EtaConfig, now: () => Date,
  emailProvider?: EmailProvider,
): Promise<RowOutcome> {
  // `docType` decides which ETA API is polled — the two families have different
  // endpoints, response shapes and status vocabularies. See `FiscalProvider.poll`.
  const result = await provider.poll(row.submissionUuid!, cfg, row.docType);

  if (result.status === "accepted") return persistAccepted(tenantId, row, result, now, emailProvider);
  if (result.status === "rejected") {
    // A re-POSTed receipt can be refused in async validation precisely BECAUSE
    // an earlier copy was filed. That is the earlier copy's success, not this
    // document's rejection — see `settleAlreadyFiled`.
    if (row.docType !== "e_invoice" && row.etaUuid && looksLikeAlreadyFiled(result.responseJson)) {
      return settleAlreadyFiled(tenantId, row, provider, cfg, row.etaUuid, now, emailProvider);
    }
    return persistRejected(tenantId, row, result, now);
  }

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
        .where(heldBy(tenantId, row, LIVE_STATUSES)));
  }
  return "deferred";
}

async function persistAccepted(
  tenantId: string, row: ClaimedRow, result: FiscalSubmitResult, now: () => Date,
  emailProvider?: EmailProvider,
): Promise<RowOutcome> {
  const won = await withTenant(tenantId, async (tx) => {
    const written = await tx.update(etaSubmissions).set({
      status: "accepted",
      acceptedAt: now(),
      // ETA's own identifier for the accepted document; for the RECEIPT family
      // ours (etaUuid) was written at finalization and never changes, which is
      // why the uuid below is written for `e_invoice` only — that is the family
      // whose uuid ETA assigns, and a poll is the second place it can arrive
      // (the 202 is the first; see `submitPhase`).
      ...(result.etaLongId ? { etaLongId: result.etaLongId } : {}),
      ...(row.docType === "e_invoice" && result.etaUuid ? { etaUuid: result.etaUuid } : {}),
      ...(result.submissionUuid ? { submissionUuid: result.submissionUuid } : {}),
      responseJson: result.responseJson,
      lastError: null,
    }).where(heldBy(tenantId, row, LIVE_STATUSES)).returning({ id: etaSubmissions.id });

    // FENCED: a stale drain (lease lost) or a row already terminal writes
    // nothing — and then audits nothing and emails nobody.
    if (written.length === 0) return false;

    await recordFiscalAudit(auditActor(tenantId), {
      action: FISCAL_AUDIT_ACTIONS.accepted,
      entityId: row.id,
      summary: `Fiscal ${row.docType} accepted by ETA`,
      metadata: { docType: row.docType, etaLongId: result.etaLongId ?? null },
      actorType: "system",
    }, tx);
    return true;
  });
  if (!won) return "deferred";

  // ------------------------------------------------------------------------
  // THE CUSTOMER'S COPY — AFTER the transaction has COMMITTED, and the position
  // is the whole design rather than an ordering detail.
  //
  // NOT INSIDE THE TX, for two independent reasons either of which would settle
  // it. (1) It makes an HTTP call to a third party. Holding a database
  // connection open across a network round trip to Resend puts a stranger's
  // latency inside a transaction that has already declared a tax document, and
  // this worker's per-row transactions exist precisely so one slow row cannot
  // block its siblings. (2) A throw inside that tx would ROLL BACK THE
  // ACCEPTANCE — the status, the `acceptedAt`, the `etaLongId` and the audit
  // event — leaving a row that says "submitted" for a document ETA has
  // accepted, which the next pass would poll again. A failed courtesy email
  // would have unfiled a fiscal fact.
  //
  // THE SAME PLACE THE AUDIT AND NOTIFY CALLS ARE *NOT*, and the contrast is
  // deliberate: `recordFiscalAudit` and `notifyFiscalFailure` run INSIDE the tx
  // because they must be atomic with the status write (an accepted row with no
  // audit event is a compliance gap). This is the opposite kind of effect —
  // it must never be atomic with it, because it must never be able to undo it.
  //
  // IT CANNOT THROW. `deliverFiscalDocumentEmail` catches everything and
  // resolves to a stamped column; the `await` is here only so the outcome is
  // recorded before the drain moves on. Acceptance is returned regardless of
  // what it says.
  //
  // BOTH FAMILIES. A receipt and an invoice both reach this line; the family
  // split lives in the renderer, not in a branch here, so neither can be added
  // to the pipeline and silently miss the email.
  // ------------------------------------------------------------------------
  await deliverFiscalDocumentEmail(tenantId, row.id, now, emailProvider);

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
  const won = await withTenant(tenantId, async (tx) => {
    const written = await tx.update(etaSubmissions).set({
      status: "rejected",
      responseJson: result.responseJson,
      lastError: `rejected: ${detail}`,
      ...(result.submissionUuid ? { submissionUuid: result.submissionUuid } : {}),
      // A terminal row is waiting for nothing, so a FUTURE nextAttemptAt on it
      // is meaningless — and worse than meaningless on the dashboard, where it
      // reads as "retrying shortly". Setting it to now says the opposite. (An
      // `accepted` row keeps whatever lease residue it had: harmless, because
      // the claim query filters on status before it ever looks at the clock.)
      nextAttemptAt: now(),
    }).where(heldBy(tenantId, row, LIVE_STATUSES)).returning({ id: etaSubmissions.id });

    // FENCED — the regression this guards is accepted -> rejected: a stale
    // drain still holding an old verdict must not overwrite a newer one.
    if (written.length === 0) return false;

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
    return true;
  });
  return won ? "rejected" : "deferred";
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
      // nextAttemptAt: a terminal row waits for nothing — see persistRejected.
      .set({ status: "failed", attempts: MAX_ATTEMPTS, lastError, nextAttemptAt: now() })
      .where(and(
        heldBy(tenantId, row, LIVE_STATUSES),
        lt(etaSubmissions.attempts, MAX_ATTEMPTS),
      ))
      .returning({ id: etaSubmissions.id });

    if (terminalized.length === 0) return;

    // The SAME predicate that decides who alerts also decides who audits, so the
    // compliance log gets exactly one `failed` event per document even when two
    // drains hold the row (round 2 Task 10b).
    await recordFiscalAudit(auditActor(tenantId), {
      action: FISCAL_AUDIT_ACTIONS.failed,
      entityId: row.id,
      summary: `Fiscal ${row.docType} failed permanently and will not be retried`,
      metadata: { docType: row.docType, lastError },
      actorType: "system",
    }, tx);

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

/**
 * `attempts++` and back off, honouring ETA's `Retry-After` as a FLOOR (APIs
 * Governance: the wait "should be larger then the value returned"). The alert
 * fires on the attempt that reaches the cap — once, because the claim query
 * then excludes the row.
 *
 * EXCEPT FOR A ROW ETA ALREADY HOLDS. A row with a `submissionUuid` is in the
 * poll phase: the document is filed and only the VERDICT is outstanding, so a
 * transport failure there says nothing about the document and must not walk it
 * toward a terminal "could not be submitted" alert. It keeps its attempts,
 * backs off by `POLL_RETRY_BACKOFF_MS` (or longer, if ETA asked), and keeps
 * polling; the read layer's `overdue` flag is what surfaces one that never
 * resolves.
 */
async function failTransiently(tenantId: string, row: ClaimedRow, err: unknown, now: () => Date): Promise<RowOutcome> {
  const polling = row.submissionUuid !== null;
  const attempts = polling ? row.attempts : row.attempts + 1;
  const exhausted = !polling && attempts >= MAX_ATTEMPTS;
  const retryAfterMs = err instanceof EtaTransportError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
  const backoffMs = Math.max(polling ? POLL_RETRY_BACKOFF_MS : 2 ** attempts * BACKOFF_BASE_MS, retryAfterMs);
  // REDACTED, not raw. This codebase's own error classes keep their (bounded)
  // text; anything else — a Drizzle error whose message carries the failing
  // query's parameters, a raw HTTP client error — is reduced to its class name.
  const lastError = redactedErrorSummary(err);

  await withTenant(tenantId, async (tx) => {
    // Compare-and-set on the attempt count we READ at claim time, AND on the
    // lease. Two drains holding one row (an expired lease) must not both
    // increment it, and at the cap they must not both alert; nor may a stale
    // drain turn a row another drain has since accepted back into `failed`.
    const advanced = await tx.update(etaSubmissions).set({
      status: "failed", attempts, lastError,
      nextAttemptAt: new Date(now().getTime() + backoffMs),
    }).where(and(
      heldBy(tenantId, row, LIVE_STATUSES),
      eq(etaSubmissions.attempts, row.attempts),
    )).returning({ id: etaSubmissions.id });

    if (exhausted && advanced.length > 0) {
      // ONLY on the attempt that exhausts the cap — this function also runs on
      // attempts 1..5, where the row is `failed` but still scheduled and nothing
      // terminal has happened. Auditing each of those would file six compliance
      // events for one document and bury the one that says it stopped.
      await recordFiscalAudit(auditActor(tenantId), {
        action: FISCAL_AUDIT_ACTIONS.failed,
        entityId: row.id,
        summary: `Fiscal ${row.docType} failed ${MAX_ATTEMPTS} times and will not be retried`,
        metadata: { docType: row.docType, attempts, lastError },
        actorType: "system",
      }, tx);

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

/** Statuses a drain may still write over: the non-terminal ones. */
const LIVE_STATUSES: readonly EtaSubmissionStatus[] = ["pending", "failed", "submitted"];

/** Statuses from which a row may be (re)submitted. `submitted` is not one: a
 *  row with a handle is polled, never re-sent. */
const SUBMITTABLE: readonly EtaSubmissionStatus[] = ["pending", "failed"];

/**
 * THE WRITE FENCE every worker write carries: this row, in one of `statuses`,
 * and STILL CARRYING THIS DRAIN'S LEASE.
 *
 * The claim lease is `next_attempt_at`, and it can expire while a call is in
 * flight (see `CLAIM_LEASE_MS`); another pass then claims the row and writes a
 * NEW `next_attempt_at`. Requiring the value this drain's claim wrote makes the
 * stale drain's writes match nothing — it cannot re-submit, cannot regress an
 * accepted row to rejected or failed, and does not audit or alert. The status
 * predicate is the second wall: even with the lease intact, a terminal row is
 * never rewritten. Callers use `.returning()` and treat zero rows as "not
 * ours any more".
 */
function heldBy(tenantId: string, row: ClaimedRow, statuses: readonly EtaSubmissionStatus[]): SQL {
  return and(
    eq(etaSubmissions.tenantId, tenantId),
    eq(etaSubmissions.id, row.id),
    sql`${etaSubmissions.nextAttemptAt} = ${row.leaseUntil}::timestamptz`,
    inArray(etaSubmissions.status, [...statuses]),
  )!;
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
