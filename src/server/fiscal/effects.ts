import { db } from "@/db/client";
import { recordAuditEvent, type AuditContext, type AuditEventInput } from "@/server/audit/service";
import { notify, type NotifyEvent } from "@/server/notifications/service";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Adapters onto Spec 4 (`recordAuditEvent`, `src/server/audit/service.ts`)
 * and Spec 5 (`notify`, `src/server/notifications/service.ts`) for the
 * fiscal subsystem.
 *
 * The plan's original text asked these to "degrade gracefully" — a no-op
 * when the audit/notifications modules were not yet on the branch, mirroring
 * how the refund spec degrades when the inventory spec is absent. That
 * caveat predates Specs 4/5 landing: both modules exist on THIS branch
 * already (imported above), so the graceful-degradation indirection would
 * be dead code here and is deliberately omitted. If either module is ever
 * removed from a branch that still carries this file, that is a compile
 * error, not a silent no-op — the correct signal.
 *
 * Kept as thin named wrappers regardless, so Task 5's worker (the only
 * caller — no fiscal code calls these before the worker exists) has ONE
 * seam to call through, and one place that owns the fiscal event-name
 * vocabulary rather than every call site restating action strings /
 * notification shape by hand.
 */

/**
 * Audit action names for one `eta_submissions` row's lifecycle (Task 5's
 * worker: submit, then the terminal accept/reject). `recordAuditEvent`'s
 * `action` is a free-form string, not enum-constrained — these are
 * namespaced under `eta.submission.*` alongside the house's dotted-action
 * convention (`sale.recorded`, `refund.issued`, `discount.line_applied`, …).
 */
export const FISCAL_AUDIT_ACTIONS = {
  submitted: "eta.submission.submitted",
  accepted: "eta.submission.accepted",
  rejected: "eta.submission.rejected",
  /**
   * TERMINAL FAILURE — the document never reached a verdict and will not be
   * retried. Added by round 2 Task 10b, when the widened audit scan showed the
   * two writers that produce this state were mutating the fiscal record without
   * recording it.
   *
   * IT IS NOT `rejected`, AND THE DIFFERENCE IS THE WHOLE POINT OF A SEPARATE
   * ACTION. `rejected` means ETA looked at the document and refused it — a
   * verdict, with a correction path (`referenceOldUUID`, addendum C3).
   * `failed` means ETA never judged it at all: the data could not be built into
   * a valid document, the tenant's configuration is incomplete, or transport
   * gave out after `MAX_ATTEMPTS`. To an auditor asking why a sale is
   * undeclared those are opposite answers — one says the taxpayer filed and was
   * refused, the other says nothing was ever filed — and collapsing them into
   * one action would make the audit trail claim an ETA interaction that never
   * happened.
   *
   * EMITTED ONCE PER DOCUMENT, on the write that makes the failure terminal:
   * `failPermanently` always, `failTransiently` only on the attempt that
   * exhausts the cap. An event per retry would put six rows in the compliance
   * log for one document and bury the one that matters.
   */
  failed: "eta.submission.failed",
} as const;

/**
 * The fixed `notify` shape for a terminal fiscal failure — see
 * `notifyFiscalFailure` below for the rationale behind this exact
 * type/severity pair. Named so Task 5's worker (and any other future caller)
 * references THIS constant rather than restating the two literals inline —
 * the other half of the "one event-name vocabulary" this file exists for.
 */
export const FISCAL_FAILURE_NOTIFICATION = { type: "system_alert", severity: "critical" } as const;

/**
 * Thin wrapper over `recordAuditEvent`, `entityType` fixed to
 * `"eta_submission"` so every call site agrees on it (the caller supplies
 * `action` — see `FISCAL_AUDIT_ACTIONS` — plus `entityId`, `summary`, and
 * optional `metadata`/`actorType`).
 *
 * `tx` is REQUIRED, exactly like `recordAuditEvent` itself: it must run on
 * the SAME transaction as the submission-row write it records, never
 * standalone (see `recordAuditEvent`'s own doc comment).
 */
export async function recordFiscalAudit(
  ctx: AuditContext,
  event: Omit<AuditEventInput, "entityType">,
  tx: Tx,
): Promise<void> {
  await recordAuditEvent(ctx, { ...event, entityType: "eta_submission" }, tx);
}

/**
 * Thin wrapper over `notify` for a terminal fiscal failure (Task 5: retry
 * attempts exhausted, an unresolvable `MissingTaxCodeError`/`EtaConfigError`,
 * etc). Fixed to `FISCAL_FAILURE_NOTIFICATION` (`type: "system_alert"` /
 * `severity: "critical"`) — the same shape the notifications layer already
 * uses for its own send-budget/tamper failures (`notifications/worker.ts`,
 * `notifications/email-events.ts`) — so the dashboard's "critical" feed has
 * one consistent type to filter on rather than a bespoke fiscal one the
 * `notification_type` enum does not carry (adding a dedicated enum value is
 * a schema change, out of scope here).
 *
 * `tx` is optional, exactly like `notify` itself: pass it to keep the
 * notification atomic with the same-transaction status write; omit it to
 * let `notify` open its own `withTenant`.
 *
 * ONE CALLER IS NOT A FAILURE, and it is named here rather than left to be
 * discovered as a misuse. Round 2 Task 8's LATE-WINDOW NOTICE (`worker.ts`,
 * `noteLateSubmission`) goes through this same seam while the document is still
 * pending and may yet be accepted — nothing has failed. It belongs on the same
 * feed at the same severity anyway: a receipt past ETA's 24-hour window needs a
 * Late Submission Request made by a taxpayer representative on ETA's portal
 * against a yearly quota, which is a compliance obligation with a deadline
 * already behind it, and burying that under a lower severity than "a document
 * was rejected" would rank it by how ServeOS feels about it rather than by what
 * it costs the owner. It stays bounded because the write that precedes it is a
 * compare-and-set: ONE alert per document, forever, not one per drain pass.
 * If a genuinely lower-stakes fiscal notice ever appears, split the shape then —
 * a second severity is a `notification_type` conversation, not a rename here.
 */
export async function notifyFiscalFailure(
  ctx: { tenantId: string },
  event: Omit<NotifyEvent, "type" | "severity">,
  tx?: Tx,
): Promise<void> {
  await notify(ctx, { ...event, ...FISCAL_FAILURE_NOTIFICATION }, tx);
}
