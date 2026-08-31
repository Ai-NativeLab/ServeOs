import QRCode from "qrcode";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import {
  etaSubmissions,
  etaSubmissionStatusEnum,
  type EtaDocType,
  type EtaSubmissionStatus,
} from "./schema";
import { SUBMISSION_WINDOW_MS } from "./worker";

/**
 * The fiscal READ surfaces — what a cashier's till and the owner's dashboard
 * ask about documents that already exist.
 *
 * SPLIT FROM `./config-service` DELIBERATELY, along the permission seam. Every
 * function in that module is gated by `fiscal:manage` (owner only) and most of
 * them WRITE: they name the taxpayer, point at the credential store and emit
 * audit events. `getSaleFiscalStatus` here is reached by any cashier holding
 * `pos:sell`, because reading whether the till's own sale was accepted is part
 * of issuing a receipt. Keeping the two in one module meant the POS route
 * imported a file whose other exports mutate a compliance surface, and meant
 * `qrcode` — a rendering dependency of exactly one function — was pulled in by
 * every config import. Nothing here writes, and nothing here takes an actor.
 *
 * THE NO-REFERENCE RULE APPLIES HERE TOO, restated rather than cross-referenced
 * so it survives someone reading only this file. The `client_secret_ref`,
 * `signing_key_ref`, `client_secret_1_ref`, `client_secret_2_ref` and
 * `preshared_key_ref` columns name where a credential lives; no function in
 * either module may return one. These surfaces do not read those columns at
 * all, but they do return `lastError`, which is worker-written free text about
 * a failed submission — the one place a reference could plausibly arrive by
 * accident.
 *
 * THE MASKING WALK THAT ENFORCES IT LIVES IN `config-service.test.ts`, covering
 * BOTH modules from one place: it seeds a tenant, exercises every read and
 * write surface, and walks every string in each return value (and in the audit
 * rows) for a reference or a resolved secret. Split across two test files it
 * would be two half-guarantees that could drift; kept together it is one
 * assertion over the whole fiscal API. Add a new read surface here and add it
 * to that walk.
 */

export type SaleFiscalStatus = {
  status: EtaSubmissionStatus;
  etaUuid: string | null;
  qrPayload: string | null;
  /**
   * A PNG data URL rendered from the STORED `qrPayload`. Never recomputed from
   * the document: `./finalize` persists the payload as part of the receipt's
   * fiscal identity, and re-deriving it here could print a QR that disagrees
   * with the one already hashed into the uuid.
   *
   * RE-RENDERED ON EVERY CALL from an immutable input, so it is byte-identical
   * every time and there is nothing to gain by asking again. See
   * `getSaleFiscalStatus` for what that means for a polling client.
   */
  qrImageDataUrl: string | null;
};

export type SubmissionRowView = {
  id: string;
  docType: EtaDocType;
  orderId: string | null;
  refundId: string | null;
  status: EtaSubmissionStatus;
  etaUuid: string | null;
  attempts: number;
  lastError: string | null;
  referenceOldUuid: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
  /**
   * Past ETA's 24-hour submission window with no acceptance to show for it.
   *
   * `createdAt` stands in for the document's `dateTimeIssued`, and the two are
   * the same moment for every practical purpose: the row is inserted by
   * `recordSale`'s after-commit enqueue (or, for a return, inside the refund's
   * own transaction), while `dateTimeIssued` is the parent's `placedAt` /
   * `createdAt` — seconds apart, against a 24-hour budget. Using the column we
   * already select beats parsing `requestJson` for a field the table does not
   * otherwise need.
   *
   * Derived on read rather than stored: it is a function of the clock, so a
   * persisted flag would be wrong the moment nobody wrote to the row.
   */
  overdue: boolean;
};

/** The dashboard table's column set, shared by the list and single-row reads so
 *  the two can never drift into showing different fields. */
const SUBMISSION_ROW_COLUMNS = {
  id: etaSubmissions.id,
  docType: etaSubmissions.docType,
  orderId: etaSubmissions.orderId,
  refundId: etaSubmissions.refundId,
  status: etaSubmissions.status,
  etaUuid: etaSubmissions.etaUuid,
  attempts: etaSubmissions.attempts,
  lastError: etaSubmissions.lastError,
  referenceOldUuid: etaSubmissions.referenceOldUuid,
  createdAt: etaSubmissions.createdAt,
  acceptedAt: etaSubmissions.acceptedAt,
} as const;

/**
 * The fiscal state of one sale, for the POS receipt (Task 7).
 *
 * `null` means this order has no e-receipt row at all — a non-EG tenant, or a
 * sale whose enqueue has not landed yet. The POS renders no fiscal footer for
 * it, which is the country-gate's no-behavioural-change guarantee.
 *
 * NEWEST LIVE ROW WINS when a sale has more than one. The partial live indexes
 * (`eta_submissions_order`) cap non-rejected rows at one per (tenant, docType,
 * order), so the only way to have several is a rejection superseded by a
 * corrected resubmission — and the correction is the document that counts. The
 * unfiltered `eta_submissions_order_lookup` index is what makes reading across
 * both cheap.
 *
 * POLLING CONTRACT — read this before writing the client (Task 7). The QR is
 * rendered fresh on every call from `qrPayload`, which `./finalize` writes ONCE
 * and never changes. So the image is byte-identical on every call: a client
 * that already holds a `qrImageDataUrl` gains nothing by asking again, and each
 * extra call costs a PNG encode on the server. The receipt screen should render
 * the QR once and STOP polling as soon as it holds both the image and a
 * terminal status. `accepted` and `rejected` are terminal; `pending`,
 * `submitted` and `failed` are not — `failed` is retried by the worker up to
 * `MAX_ATTEMPTS`, so a client polling "until not failed" would poll forever
 * against a permanently failed row. Task 7 owns the bounded poll.
 */
export async function getSaleFiscalStatus(
  tenantId: string,
  orderId: string,
): Promise<SaleFiscalStatus | null> {
  const row = await withTenant(tenantId, async (tx) => {
    const [found] = await tx
      .select({
        status: etaSubmissions.status,
        etaUuid: etaSubmissions.etaUuid,
        qrPayload: etaSubmissions.qrPayload,
      })
      .from(etaSubmissions)
      .where(
        and(
          eq(etaSubmissions.tenantId, tenantId),
          eq(etaSubmissions.orderId, orderId),
          eq(etaSubmissions.docType, "e_receipt"),
        ),
      )
      // LIVE ROW FIRST, then newest. The partial live indexes
      // (`eta_submissions_order`) cap non-rejected rows at one per (tenant,
      // docType, order), so "not rejected" identifies the document that counts
      // whenever one exists, and `createdAt` picks the latest rejection
      // otherwise. Ordering on `createdAt` alone would be right in every real
      // case but would resolve a same-instant tie arbitrarily — and resolving
      // it towards a superseded rejection would print "rejected" on a receipt
      // whose correction is already in flight.
      .orderBy(
        sql`(${etaSubmissions.status} <> 'rejected') desc`,
        desc(etaSubmissions.createdAt),
        desc(etaSubmissions.id),
      )
      .limit(1);
    return found ?? null;
  });

  if (!row) return null;
  return {
    status: row.status,
    etaUuid: row.etaUuid,
    qrPayload: row.qrPayload,
    qrImageDataUrl: row.qrPayload ? await QRCode.toDataURL(row.qrPayload) : null,
  };
}

export type ListSubmissionsOptions = {
  /** Rows per page. Capped so a hand-built query string cannot ask for the
   *  tenant's whole fiscal history in one response. */
  limit?: number;
  offset?: number;
  status?: EtaSubmissionStatus;
};

const SUBMISSIONS_PAGE_LIMIT = 50;

/**
 * The dashboard's submission feed: newest first, paginated, with everything the
 * table renders and nothing else. `requestJson`/`responseJson` are deliberately
 * NOT selected — they are the fiscal document and ETA's raw reply, several
 * kilobytes each, and the table shows neither.
 */
export async function listSubmissions(
  tenantId: string,
  opts: ListSubmissionsOptions = {},
): Promise<{ rows: SubmissionRowView[]; hasMore: boolean }> {
  const now = Date.now();
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 25), 1), SUBMISSIONS_PAGE_LIMIT);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);

  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select(SUBMISSION_ROW_COLUMNS)
      .from(etaSubmissions)
      .where(
        opts.status
          ? and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.status, opts.status))
          : eq(etaSubmissions.tenantId, tenantId),
      )
      .orderBy(desc(etaSubmissions.createdAt), desc(etaSubmissions.id))
      // One extra row decides `hasMore` without a second COUNT(*) over a table
      // that only grows.
      .limit(limit + 1)
      .offset(offset),
  );

  return { rows: rows.slice(0, limit).map((row) => withOverdue(row, now)), hasMore: rows.length > limit };
}

/**
 * Stamps the 24-hour-window verdict onto a row.
 *
 * `accepted` is the only status that closes the obligation — a `rejected` or
 * `failed` document past the window is still a receipt ETA never accepted, and
 * hiding that behind "it is terminal" is exactly the reporting gap addendum §3
 * asks to close ("retry/backoff must respect the 24h budget and flag
 * breaches"). The worker deliberately does not enforce the deadline, because
 * giving up at it would turn a late document into no document; flagging it here
 * is the other half of that decision.
 */
function withOverdue<T extends { status: EtaSubmissionStatus; createdAt: Date; acceptedAt: Date | null }>(
  row: T, now: number,
): T & { overdue: boolean } {
  return { ...row, overdue: row.status !== "accepted" && now - row.createdAt.getTime() > SUBMISSION_WINDOW_MS };
}

/**
 * One submission row, masked to the same fields the dashboard table shows.
 *
 * Exists so the resubmit path can answer 404 (no such row) and 409 (not
 * rejected, or rejected before it ever reached ETA) from data rather than by
 * pattern-matching the messages `enqueueCorrectedResubmission` throws. That
 * function stays the authority — it re-checks both preconditions inside its own
 * transaction — but a thrown `Error` with a prose message is not something an
 * HTTP layer should be discriminating on.
 */
export async function getSubmissionById(
  tenantId: string,
  submissionId: string,
): Promise<SubmissionRowView | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select(SUBMISSION_ROW_COLUMNS)
      .from(etaSubmissions)
      .where(and(eq(etaSubmissions.tenantId, tenantId), eq(etaSubmissions.id, submissionId)))
      .limit(1);
    return row ? withOverdue(row, Date.now()) : null;
  });
}

export type SubmissionStatusCounts = Record<EtaSubmissionStatus, number>;

/**
 * How many submissions the tenant holds in each fiscal state.
 *
 * The paginated feed cannot answer this — 25 rows of "newest first" say nothing
 * about the four rejections from last Tuesday, which are exactly the rows an
 * owner opens this screen to find. One `GROUP BY` over the whole table is both
 * cheaper and more honest than counting a page.
 *
 * EVERY status is present, zero-filled, in the enum's own order. A chip row
 * built from a sparse map would appear and disappear as documents move between
 * states, and "rejected: 0" is a materially different thing to be told than
 * nothing at all.
 */
export async function getSubmissionStatusCounts(tenantId: string): Promise<SubmissionStatusCounts> {
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({ status: etaSubmissions.status, n: count() })
      .from(etaSubmissions)
      .where(eq(etaSubmissions.tenantId, tenantId))
      .groupBy(etaSubmissions.status),
  );

  const counts = Object.fromEntries(
    etaSubmissionStatusEnum.enumValues.map((status) => [status, 0]),
  ) as SubmissionStatusCounts;
  for (const row of rows) counts[row.status] = Number(row.n);
  return counts;
}
