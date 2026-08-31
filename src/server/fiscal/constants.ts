/**
 * Fiscal constants shared by modules that must NOT import each other.
 *
 * This file exists for one reason and should stay that small. `SUBMISSION_WINDOW_MS`
 * is a rule of ETA's, not a fact about the worker — the worker uses it to reason
 * about its retry budget and `read-model.ts` uses it to flag overdue documents.
 * It lived in `worker.ts`, which meant `read-model.ts` imported the worker, which
 * dragged the ETA HTTP client, the provider and the transport error taxonomy into
 * the import graph of every dashboard page and POS route that reads a submission.
 *
 * Folding it into `read-model.ts` instead would invert a worse dependency — the
 * submission worker importing the dashboard's read layer — so the constant lives
 * on its own, imported by both and importing nothing.
 */

/**
 * ETA's submission window: a receipt must reach ETA within 24 hours of the
 * `dateTimeIssued` it carries. Past it the document needs a formal Late
 * Submission Request (addendum §3), a path this pipeline does not implement.
 *
 * NOT ENFORCED BY THE WORKER, and deliberately so — a worker that stopped
 * retrying at the deadline would turn a late document into no document, which is
 * strictly worse. It is a REPORTING threshold: `read-model.ts` marks any
 * non-accepted row older than this `overdue`, and the fiscal dashboard shows it,
 * which is where addendum §3's "retry/backoff must respect the 24h budget and
 * flag breaches" is actually satisfied. The arithmetic that keeps ordinary
 * retries inside it (constants in `./worker`):
 *
 *     MAX_ATTEMPTS (6) with backoff 2^n x 30s  ->  ~31 min of retrying (60+120+240+480+960s; the 6th backoff is written but never served — the claim excludes attempts >= MAX_ATTEMPTS)
 *     + POLL_INTERVAL_MS (60s) per poll
 *     << SUBMISSION_WINDOW_MS (24h)
 *
 * so a document only goes overdue when ETA is unreachable for a day or the
 * tenant's configuration is broken — both of which are exactly what the
 * dashboard's overdue marker is for.
 */
export const SUBMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;
