import { withTenant } from "@/db/with-tenant";
import type { DashboardContext } from "@/server/auth/dashboard-context";
import { actionAudit } from "@/server/audit/action-context";
import { recordAuditEvent } from "@/server/audit/service";
import { enqueueCorrectedResubmission } from "@/server/fiscal/enqueue";
import { getSubmissionById } from "@/server/fiscal/config-service";

export type ResubmitOutcome =
  | { ok: true; submissionId: string }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Queues a CORRECTED RESUBMISSION of a rejected document, on a named person's
 * say-so, and records who that was.
 *
 * WHY THIS IS ONE FUNCTION AND NOT TWO. The dashboard reaches the same act from
 * two directions — the API route (`api/dashboard/fiscal/submissions/[id]/resubmit`)
 * and the page's server action — and the audit event is the whole reason either
 * of them exists. `enqueueCorrectedResubmission` takes `{ tenantId }` and no
 * actor, so it is allowlisted in `audit/coverage.ts` with an explicit note that
 * the who-asked-for-it event belongs to the dashboard: deciding a rejection is
 * understood and the data now correct is a human judgement, and an event
 * attributed to the system would be a lie about who made it. Duplicating the
 * emission across two callers is how one of them silently loses it.
 *
 * ORDERING, and its one honest cost: `enqueueCorrectedResubmission` opens its
 * own transaction, so the event cannot be atomic with the insert. The insert
 * goes FIRST — if the audit write then fails, an unattributed correction exists
 * and the worker will still record its lifecycle
 * (`eta.submission.submitted|accepted|rejected`), which is strictly better than
 * an audit row claiming a correction that was never queued.
 *
 * PRECONDITIONS are read before the call so the caller can answer with a real
 * status. `enqueueCorrectedResubmission` re-checks both inside its transaction
 * and remains the authority; this read only decides which refusal to report.
 */
export async function requestResubmission(
  ctx: DashboardContext,
  submissionId: string,
): Promise<ResubmitOutcome> {
  const original = await getSubmissionById(ctx.tenantId, submissionId);
  if (!original) {
    return { ok: false, status: 404, error: "Submission not found" };
  }
  if (original.status !== "rejected") {
    return {
      ok: false,
      status: 409,
      error: `Submission is ${original.status}, not rejected — only a document ETA refused can be superseded by a correction`,
    };
  }
  if (!original.etaUuid) {
    return {
      ok: false,
      status: 409,
      error:
        "Submission was rejected without an ETA uuid, so there is no document for a correction to reference — it never reached ETA",
    };
  }

  const newSubmissionId = await enqueueCorrectedResubmission({ tenantId: ctx.tenantId }, submissionId);
  if (newSubmissionId === null) {
    // The live partial index refused the insert: a correction for this sale is
    // already queued. Two live corrections would be two documents ETA could
    // both accept, declaring one sale twice.
    return { ok: false, status: 409, error: "A correction for this document is already queued" };
  }

  const audit = await actionAudit(ctx);
  await withTenant(ctx.tenantId, (tx) =>
    recordAuditEvent(
      { tenantId: ctx.tenantId, actorUserId: audit.actorUserId ?? null, fingerprint: audit.fingerprint },
      {
        action: "eta.submission.resubmission_requested",
        entityType: "eta_submission",
        // The NEW row: the event records a document coming into existence, and
        // the rejected original is named in metadata rather than the other way
        // round, so the correction's own history starts with who asked for it.
        entityId: newSubmissionId,
        summary: `Corrected resubmission queued for ${original.docType} ${original.etaUuid}`,
        metadata: {
          originalSubmissionId: submissionId,
          referenceOldUuid: original.etaUuid,
          docType: original.docType,
          roleKey: audit.roleKey ?? null,
        },
        actorType: audit.actorType ?? "user",
      },
      tx,
    ),
  );

  return { ok: true, submissionId: newSubmissionId };
}
