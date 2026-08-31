import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { etaSubmissions } from "./schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The country gate for the whole fiscal subsystem (F1/F2): ETA e-invoicing /
 * e-receipts is an Egypt-specific obligation, so only a tenant whose
 * `country` is `"EG"` ever gets a fiscal submission enqueued — every other
 * country enqueues nothing and sees no behavioural change.
 *
 * Evaluated PER SALE, at enqueue time — a plain, uncached `tenants` select.
 * A tenant's country essentially never changes post-onboarding, so this is
 * cheap and deliberately not memoized: the alternative (a cached/stale gate)
 * risks a tenant that changed country continuing to enqueue (or skip) based
 * on a value that no longer holds.
 */
export async function isFiscalEnabled(tenantId: string): Promise<boolean> {
  const [t] = await db.select({ country: tenants.country }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return t?.country === "EG";
}

/**
 * A discriminated union, not an `{ orderId?, refundId? }` bag: the `docType`
 * decides which parent id is REQUIRED, so a caller cannot construct (or
 * TypeScript accept) an `e_receipt` carrying a `refundId`, or a
 * `return_receipt` carrying an `orderId` — the same split the
 * `eta_submissions_parent_xor` CHECK constraint enforces in the database.
 * The type system makes the mistake unrepresentable; the CHECK is the
 * backstop for anything that reaches the DB some other way.
 */
export type EnqueueInput =
  | { docType: "e_receipt" | "e_invoice"; orderId: string }
  | { docType: "return_receipt" | "credit_note"; refundId: string };

// The exact predicate text of the ORIGINAL-document partial unique indexes
// (`eta_submissions_order_original` / `eta_submissions_refund_original`,
// schema.ts) that enqueue idempotency must target. Postgres requires an
// `ON CONFLICT (...) WHERE <predicate>` arbiter's predicate to match a
// partial index's predicate to infer it as the conflict target — an
// `onConflictDoNothing` with the right columns but no (or a mismatched)
// `where` either targets the WRONG index (the non-partial-status one) or
// fails outright with "no unique or exclusion constraint matching the ON
// CONFLICT specification". Defined once, here, so the two can never drift
// apart from the schema that they mirror.
const ORDER_ORIGINAL_WHERE = sql`${etaSubmissions.orderId} is not null and ${etaSubmissions.referenceOldUuid} is null`;
const REFUND_ORIGINAL_WHERE = sql`${etaSubmissions.refundId} is not null and ${etaSubmissions.referenceOldUuid} is null`;

// The predicate text of the LIVE-document partial unique indexes
// (`eta_submissions_order` / `eta_submissions_refund`), which cap NON-REJECTED
// rows at one per (tenant, docType, order|refund). Same arbiter-inference rule
// as the pair above, different question: those cap the original document
// forever, these cap how many documents are in play RIGHT NOW.
//
// This is the pair a corrected resubmission targets. It carries
// `referenceOldUuid`, so it falls outside the ORIGINAL predicate entirely and
// nothing there would stop a second, third and fourth correction from
// coexisting; these indexes are what make "one live document per sale" true.
const ORDER_LIVE_WHERE = sql`${etaSubmissions.orderId} is not null and ${etaSubmissions.status} <> 'rejected'`;
const REFUND_LIVE_WHERE = sql`${etaSubmissions.refundId} is not null and ${etaSubmissions.status} <> 'rejected'`;

/**
 * Inserts a `pending` `eta_submissions` row. NO network call — a cheap,
 * durable local write; the async worker (Task 5) does the actual ETA I/O.
 *
 * Idempotent via `onConflictDoNothing` targeting the ORIGINAL-document
 * partial unique index (`eta_submissions_order_original` /
 * `_refund_original`), predicate included. That index ignores `status`, so a
 * duplicate enqueue for the same (tenant, docType, order|refund) is always a
 * no-op — even once the first row has been rejected. A deliberate corrected
 * resubmission after rejection is a NEW row that carries `referenceOldUuid`
 * (Task 5's job, via the worker/builder), which falls outside this
 * predicate and is admitted freely; this function never writes
 * `referenceOldUuid`, so it can only ever produce (or no-op against) an
 * original.
 *
 * Runs on the caller's transaction when one is passed, or opens its own
 * `withTenant` otherwise:
 *
 *   - Refund path (`tx` passed): the enqueue is part of the SAME transaction
 *     as the refund it accompanies. A failed insert here rolls the refund
 *     back WITH it — correct, because the refund has not yet been handed to
 *     a customer at that point, so refusing the whole operation is safe and
 *     keeps "a refund exists" and "its fiscal record was durably queued" from
 *     ever diverging.
 *
 *   - Sale path (`tx` omitted): called strictly AFTER `recordSale`'s own
 *     transaction has committed. The sale is authoritative and must never be
 *     blocked or rolled back by fiscal logic — so this opens an independent
 *     transaction, and the caller is expected to catch and log any failure
 *     rather than let it propagate (see `record-sale.ts`).
 */
export async function enqueueFiscalDocument(ctx: { tenantId: string }, input: EnqueueInput, tx?: Tx): Promise<void> {
  // `"orderId" in input` narrows the discriminated union by shape rather than
  // by comparing `docType` against two literals at a time. The narrowing works
  // here for the ordinary reason — the check sits INSIDE the closure, so it
  // applies to the branch it guards; `input` is a const parameter, so there is
  // no captured-variable subtlety to survive in the first place.
  const run = (tx: Tx) =>
    "orderId" in input
      ? tx.insert(etaSubmissions).values({
          tenantId: ctx.tenantId, docType: input.docType, orderId: input.orderId, refundId: null,
          status: "pending" as const, attempts: 0, requestJson: {},
        }).onConflictDoNothing({
          target: [etaSubmissions.tenantId, etaSubmissions.docType, etaSubmissions.orderId],
          where: ORDER_ORIGINAL_WHERE,
        })
      : tx.insert(etaSubmissions).values({
          tenantId: ctx.tenantId, docType: input.docType, orderId: null, refundId: input.refundId,
          status: "pending" as const, attempts: 0, requestJson: {},
        }).onConflictDoNothing({
          target: [etaSubmissions.tenantId, etaSubmissions.docType, etaSubmissions.refundId],
          where: REFUND_ORIGINAL_WHERE,
        });

  if (tx) {
    await run(tx);
    return;
  }
  await withTenant(ctx.tenantId, run);
}

/**
 * Queues a CORRECTED RESUBMISSION of a rejected document.
 *
 * ETA does not accept a fix in place. A corrected receipt is a NEW document
 * with a NEW self-computed uuid, still chained to its device's head, carrying
 * `referenceOldUUID` = the rejected document's uuid (addendum C3). So this
 * inserts a new row rather than touching the rejected one — which stays
 * exactly as ETA left it, under the same 5-year retention as every other
 * fiscal record. `./finalize` reads `referenceOldUuid` back off the new row
 * and puts it in the wire document, where it becomes part of the new uuid's
 * hash.
 *
 * PRECONDITIONS, both refused loudly rather than papered over:
 *   - the original must be `rejected` — a pending/submitted/accepted document
 *     is not superseded by anything, and correcting an ACCEPTED receipt is a
 *     return receipt, not a resubmission;
 *   - it must carry an `etaUuid` — that uuid IS the reference, and a rejected
 *     row without one never reached ETA at all, so re-enqueueing it as an
 *     original is the right move instead.
 *
 * IDEMPOTENT against the LIVE index pair: if a correction is already in play
 * for this sale (any non-rejected row), the insert no-ops and this returns
 * `null`. Two live corrections would be two documents ETA could both accept,
 * and the tenant would have declared one sale twice.
 *
 * NOT called automatically anywhere. Deciding that a rejection is understood
 * and the data now correct is a human judgement — the fiscal dashboard (Task
 * 6) owns the trigger. Auto-correcting on rejection would resubmit the same
 * bad data on a loop.
 *
 * @returns the new row's id, or `null` when a live document already exists.
 */
export async function enqueueCorrectedResubmission(
  ctx: { tenantId: string },
  originalSubmissionId: string,
): Promise<string | null> {
  return withTenant(ctx.tenantId, async (tx) => {
    const [original] = await tx.select().from(etaSubmissions)
      .where(and(eq(etaSubmissions.tenantId, ctx.tenantId), eq(etaSubmissions.id, originalSubmissionId)))
      .limit(1);

    if (!original) {
      throw new Error(`fiscal: eta_submissions row ${originalSubmissionId} not found for tenant ${ctx.tenantId}`);
    }
    if (original.status !== "rejected") {
      throw new Error(
        `fiscal: submission ${originalSubmissionId} is ${original.status}, not rejected — ` +
          "only a document ETA refused can be superseded by a corrected resubmission",
      );
    }
    if (!original.etaUuid) {
      throw new Error(
        `fiscal: submission ${originalSubmissionId} was rejected without an etaUuid, so there is no document for a ` +
          "correction to reference — it never reached ETA and should be re-enqueued as an original instead",
      );
    }

    const values = {
      tenantId: ctx.tenantId,
      docType: original.docType,
      orderId: original.orderId,
      refundId: original.refundId,
      referenceOldUuid: original.etaUuid,
      status: "pending" as const,
      attempts: 0,
      requestJson: {},
    };

    // Same shape-narrowing rule as `enqueueFiscalDocument`: which parent column
    // is set decides which live index arbitrates, and the CHECK constraint
    // guarantees exactly one of them is.
    const inserted = original.orderId
      ? await tx.insert(etaSubmissions).values(values).onConflictDoNothing({
          target: [etaSubmissions.tenantId, etaSubmissions.docType, etaSubmissions.orderId],
          where: ORDER_LIVE_WHERE,
        }).returning({ id: etaSubmissions.id })
      : await tx.insert(etaSubmissions).values(values).onConflictDoNothing({
          target: [etaSubmissions.tenantId, etaSubmissions.docType, etaSubmissions.refundId],
          where: REFUND_LIVE_WHERE,
        }).returning({ id: etaSubmissions.id });

    return inserted[0]?.id ?? null;
  });
}
