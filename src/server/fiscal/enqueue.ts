import { eq, sql } from "drizzle-orm";
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
  // Narrowed and resolved to plain, concrete values HERE — not inside the
  // `run` closure below (TypeScript does not carry a parameter's narrowing
  // into a nested function that captures it, so `run` must close over
  // already-resolved values, never re-narrow `input` itself).
  //
  // A `switch` on `input.docType`, one `case` per literal, rather than an
  // `if (input.docType === "e_receipt" || input.docType === "e_invoice")`:
  // each member's `docType` is itself a two-literal union, and TypeScript's
  // narrowing of a multi-literal discriminant does not survive an `||` of
  // two single-literal checks — a `switch` with a fall-through case group
  // narrows each literal individually and unions the two case labels
  // correctly.
  let values: typeof etaSubmissions.$inferInsert;
  let target: (
    | typeof etaSubmissions.tenantId
    | typeof etaSubmissions.docType
    | typeof etaSubmissions.orderId
    | typeof etaSubmissions.refundId
  )[];
  let where: typeof ORDER_ORIGINAL_WHERE;

  switch (input.docType) {
    case "e_receipt":
    case "e_invoice":
      values = {
        tenantId: ctx.tenantId, docType: input.docType, orderId: input.orderId, refundId: null,
        status: "pending", attempts: 0, requestJson: {},
      };
      target = [etaSubmissions.tenantId, etaSubmissions.docType, etaSubmissions.orderId];
      where = ORDER_ORIGINAL_WHERE;
      break;
    case "return_receipt":
    case "credit_note":
      values = {
        tenantId: ctx.tenantId, docType: input.docType, orderId: null, refundId: input.refundId,
        status: "pending", attempts: 0, requestJson: {},
      };
      target = [etaSubmissions.tenantId, etaSubmissions.docType, etaSubmissions.refundId];
      where = REFUND_ORIGINAL_WHERE;
      break;
  }

  const run = (t: Tx) => t.insert(etaSubmissions).values(values).onConflictDoNothing({ target, where });
  if (tx) {
    await run(tx);
    return;
  }
  await withTenant(ctx.tenantId, run);
}
