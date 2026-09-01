import type { EtaDocType } from "./schema";

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
 *
 * IT STILL IMPORTS NOTHING AT RUNTIME. The one import above is `import type`,
 * which TypeScript erases — so `isReceiptSubmissionWindowFamily` below can be
 * typed against the docType enum without putting `./schema` (and drizzle) on the
 * graph of anything that only wanted a number.
 */

/**
 * ETA's submission window: a receipt must reach ETA within 24 hours of the
 * `dateTimeIssued` it carries. Past it the document needs a formal Late
 * Submission Request (addendum §3), a path this pipeline does not implement.
 *
 * ETA'S OWN WORDS, from the Receipt Issuance FAQ
 * (`https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/`), which is the ONLY
 * SDK page that states the window at all:
 *
 *   "The receipt is allowed to be submitted within the allowed duration (24
 *    hours), unless this receipt is being resubmitted and has the OLD UUID added
 *    to the receipt/return receipt"
 *
 * and, on the escape hatch past it:
 *
 *   "Late Submission Window (Days) - Sets the maximum age of documents that will
 *    be accepted by a Late Submission Request"
 *   "Late Submission Period (Hours) - Sets the duration of the Late Submission
 *    Request that allows the taxpayer representatives to submit their requests
 *    within this duration"
 *   "Late Submission Request will consume from users current yearly quota and
 *    accept and reject submission based on the maximum number allowed."
 *
 * Those two parameters are tenant configuration ON the Late Submission Request
 * path — they say how stale a document an LSR may rescue, not when the ordinary
 * clock runs out — so they are not a second deadline and nothing here reads them.
 *
 * 24 HOURS IS A CURRENT VALUE, NOT A CONSTANT OF THE SPEC. The FAQ presents it
 * as "the allowed duration (24 hours)" — the parenthesis is the reading of a
 * SUBMISSION WORKFLOW PARAMETER that ETA configures on its side, in the same
 * family as the Late Submission parameters quoted above, not a number written
 * into the receipt specification. ETA can reconfigure it, and if it does, this
 * literal is wrong everywhere it is used with no error anywhere: submissions
 * would keep working and the dashboard would simply be flagging against the old
 * duration. That is why it is ONE constant with two readers rather than a
 * repeated literal, and it is the first thing to re-read on preprod.
 *
 * NOT ENFORCED BY THE WORKER, and deliberately so — a worker that stopped
 * retrying at the deadline would turn a late document into no document, which is
 * strictly worse, and ETA's own answer to a stale document is an LSR rather than
 * a refusal to try. Round 2 Task 8 made the worker OBSERVE the window without
 * enforcing it: on claiming a receipt-family row past it, the worker tells the
 * owner ONCE (`eta_submissions.late_notified_at`) and then submits exactly as
 * before. Noticing and refusing are different things, and only the first is
 * done here. It remains a REPORTING threshold otherwise: `read-model.ts` marks
 * any non-accepted row older than this `overdue`, and the fiscal dashboard shows
 * it, which is where addendum §3's "retry/backoff must respect the 24h budget
 * and flag breaches" is actually satisfied. The arithmetic that keeps ordinary
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

/**
 * WHICH DOCUMENT FAMILIES `SUBMISSION_WINDOW_MS` ACTUALLY GOVERNS — and the
 * honest answer is "the ones ETA published a deadline for", which is the receipt
 * pair and not the invoice.
 *
 * THE 24-HOUR RULE IS AN E-RECEIPT RULE. It appears on exactly one SDK page, the
 * Receipt Issuance FAQ, and that page is about receipts throughout.
 *
 * WHY `return_receipt` IS IN THIS SET IS AN INFERENCE, NOT A QUOTE, and saying
 * so is the difference between a scope and a claim. The rule's grammatical
 * subject is singular — "**The receipt** is allowed to be submitted within the
 * allowed duration (24 hours)" — and the string "receipt/return receipt" occurs
 * only in the trailing exception clause. So the sentence does not NAME the
 * return receipt as bound by the window. Three signals put it inside anyway:
 *
 *   1. THE CARVE-OUT PRESUPPOSES IT. The exception is "unless this receipt is
 *      being resubmitted and has the OLD UUID added to the receipt/return
 *      receipt" — an exemption written for return receipts only means something
 *      if return receipts are subject to the rule it exempts them from.
 *   2. THE PAGE TREATS THE PAIR AS ONE BASE STRUCTURE. "receipt/return receipt"
 *      is how that FAQ refers to the document throughout, matching the SDK's own
 *      `receipt-v1-2` / `return-receipt-v1-2` split of a single family.
 *   3. THE WORDING IS GENERIC NORMATIVE. "The receipt" is the family's generic
 *      noun in a rule statement, not a discriminator drawn against returns —
 *      which the page never draws.
 *
 * THE RISK IS DELIBERATELY POINTED THE SAFE WAY. If the inference is wrong, a
 * return receipt past 24h gets an owner alert about a deadline that did not bind
 * it: a false alarm on our own dashboard, with no effect on what is filed or
 * when, since the worker submits either way. Excluding returns and being wrong
 * would silently miss a real breach on a real document. Given one of those has
 * to be risked, this is the one to risk.
 *
 * NO SUBMISSION DEADLINE IS PUBLISHED FOR AN INVOICE, and that was checked
 * before this constant was written rather than assumed (round 2 Task 8's
 * pre-check, 2026-09-01). Fetched, and each came back with nothing:
 *
 *   /documents/invoice-v1-0/           — the only time constraint on the whole
 *                                        page is on the field itself: "Date and
 *                                        time cannot be in future. Time to be
 *                                        supplied in UTC timezone."
 *   /einvoicingapi/01-submit-documents/ — no deadline; its rejection vocabulary
 *                                        is BadStructure, MaximumSizeExceeded,
 *                                        IncorrectSubmitter, Forbidden,
 *                                        DuplicateSubmission — nothing temporal.
 *   /integrationpractices/             — no deadline (callback, polling and
 *                                        anti-patterns only).
 *   /faq/                              — no deadline (environment setup only).
 *
 * SO THE LATE MACHINERY IS RECEIPT-SCOPED, AND THAT IS A SCOPE RATHER THAN A
 * CLAIM. "ETA does not publish an invoice deadline" is not the same statement as
 * "an invoice has no deadline" — the ETA portal's Late Submission parameters are
 * document-agnostic in their wording, and a deadline could live in the taxpayer
 * portal or in the law rather than in the SDK. Carried as **VERIFY-13** in the
 * addendum's §5 ledger and the round-1 plan's Blocked section, to be answered on
 * preprod or by a tax adviser. Flagging an invoice today would mean alerting an
 * owner about a deadline nobody has shown us, which is worse than the silence:
 * a false alarm on a compliance surface teaches an owner to ignore it.
 *
 * WHEN THE ANSWER ARRIVES the change is small and local: an invoice window is a
 * second constant plus a docType branch on the one lookup below — nothing that
 * reads it needs to learn a new shape, because the read model already has a
 * `not-applicable` late state to move an invoice OUT of.
 */
const RECEIPT_SUBMISSION_WINDOW_FAMILY: ReadonlySet<EtaDocType> = new Set(["e_receipt", "return_receipt"]);

/**
 * Whether `SUBMISSION_WINDOW_MS` applies to this document family at all.
 *
 * Used by the worker (to decide whether a claimed row can be late) and by the
 * read model (to decide whether "on-time" is even a meaningful thing to say
 * about a row). ONE predicate rather than two `docType === "e_receipt" || …`
 * spellings, because the two would answer differently the day a third receipt
 * variant is added, and the disagreement would be invisible: the worker would
 * flag a document the dashboard renders as not-applicable.
 */
export function isReceiptSubmissionWindowFamily(docType: EtaDocType): boolean {
  return RECEIPT_SUBMISSION_WINDOW_FAMILY.has(docType);
}

/**
 * ETA's own allowance on every published calculation: "All the above
 * calculations are subject to (± 0.5) tolerance" (Main Calculations).
 *
 * Shared for the same reason `SUBMISSION_WINDOW_MS` is: `./eta-wire` holds
 * documents to it as the last check before transmission, and
 * `./build-document` uses the SAME figure to refuse a return whose stored
 * split cannot satisfy it — naming the cause while the wire can only name the
 * equation. Two copies could drift apart and let the builder pass something the
 * wire then refuses with the unhelpful message, which is exactly the outcome
 * the builder-side check exists to prevent. Used verbatim rather than tightened:
 * a stricter bound of our own would refuse documents ETA accepts.
 */
export const LINE_TAX_TOLERANCE = "0.5";
