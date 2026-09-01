import QRCode from "qrcode";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db/with-tenant";
import {
  etaSubmissions,
  etaSubmissionStatusEnum,
  type EtaDocType,
  type EtaSubmissionStatus,
} from "./schema";
import { SUBMISSION_WINDOW_MS, isReceiptSubmissionWindowFamily } from "./constants";

/**
 * The fiscal READ surfaces — what a cashier's till, the owner's dashboard and
 * the customer's own status link ask about documents that already exist.
 *
 * THREE AUDIENCES, AND THE WIDEST ONE IS UNGATED. The dashboard reads answer to
 * `fiscal:manage` (one owner); `getSaleFiscalStatus` answers to `pos:sell`;
 * `getSaleFiscalStatusByToken` (round 2, Task 6) answers to nothing but
 * possession of a link the customer may have forwarded. That last one is why
 * `lastError` matters below rather than being a footnote: it is worker-written
 * free text that legitimately names an env KEY, which is a fair trade for an
 * owner debugging a failed receipt and not one to make with the public. The
 * token surface therefore returns `SaleFiscalStatus` and only that, and the
 * masking walk holds it to a STRICTER forbidden set than the dashboard reads.
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
  /**
   * WHICH FAMILY THIS SALE WAS DECLARED AS — and the reason the field exists at
   * all rather than being inferred.
   *
   * A B2B sale (round 2, Task 5) is filed as an `e_invoice` INSTEAD of an
   * `e_receipt`, and the two print differently: a receipt carries a QR from the
   * moment it is finalized, an invoice carries no QR ever and shows ETA's
   * assigned long id once it has one. "No QR yet" cannot stand in for "this is
   * an invoice" — an `e_receipt` in the seconds before its finalization lands
   * has no QR either, and a footer reading the family off that absence would
   * print B2B text on an ordinary consumer sale.
   */
  docType: Extract<EtaDocType, "e_receipt" | "e_invoice">;
  status: EtaSubmissionStatus;
  etaUuid: string | null;
  /**
   * ETA's own human-readable document number, assigned by ETA and never by us.
   *
   * THIS IS THE B2B FOOTER. An invoice has no QR to print and no self-computed
   * uuid — the identity arrives with the 202 — so the long id is the only thing
   * a tax invoice can show the buyer. `null` until ETA has answered, which is
   * exactly the "Tax invoice — pending ETA number" state the till renders.
   *
   * An accepted `e_receipt` carries one too (the worker persists it either way);
   * the receipt footer simply prints the QR instead.
   */
  etaLongId: string | null;
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
   * WHAT HAPPENED ALONGSIDE THE FILING — the customer's copy and the late-window
   * alert, each as a NAMED STATE rather than as the nullable columns underneath.
   * See `submissionSideEffects` for why the mapping happens here and not in the
   * component that renders it.
   */
  sideEffects: SubmissionSideEffects;
  /**
   * Past ETA's 24-hour submission window with no acceptance to show for it.
   *
   * `createdAt` stands in for the document's `dateTimeIssued`, and the two are
   * the same moment for every practical purpose: the row is inserted by
   * `recordSale`'s after-commit enqueue (or, for a return, inside the refund's
   * own transaction), while `dateTimeIssued` is the parent's `placedAt` /
   * `createdAt` — seconds apart, against a 24-hour budget. (Exception: a SWEPT order — the online channel's primary path — has `createdAt` trailing `dateTimeIssued` by 5 minutes up to the 7-day horizon, so a backlog-adopted row reads not-overdue for its first 24h; bounded by RECONCILE_HORIZON_MS.) Using the column we
   * already select beats parsing `requestJson` for a field the table does not
   * otherwise need.
   *
   * Derived on read rather than stored: it is a function of the clock, so a
   * persisted flag would be wrong the moment nobody wrote to the row.
   *
   * ---------------------------------------------------------------------------
   * `overdue` IS NOT `sideEffects.late`, AND KEEPING BOTH IS THE POINT. They
   * answer different questions and disagree in both directions:
   *
   *   overdue  A LIVE CONDITION, computed from the clock on every read: this
   *            document is past the window and ETA still has not accepted it.
   *            It goes FALSE the instant acceptance lands, because the thing it
   *            describes has stopped being true. It says nothing about whether
   *            anyone was told.
   *
   *   late     A HISTORICAL FACT, read off `late_notified_at`: the worker
   *            claimed this row past the window and alerted the owner about it.
   *            It never clears — a document that went in late needs a Late
   *            Submission Request at ETA's portal whether or not it was
   *            eventually accepted, so the fact must outlive the condition.
   *
   * A row can be overdue and NOT late: a `rejected` document ages past 24h and
   * the worker will never claim it again, so nothing ever flags it — correctly,
   * since there is nothing left to submit late. And a row can be late and NOT
   * overdue: flagged at hour 25, accepted at hour 26. Collapsing them into one
   * boolean would lose whichever half the reader did not have in mind.
   */
  overdue: boolean;
};

/**
 * WHY THE CUSTOMER'S COPY WAS OR WAS NOT SENT — four states, because the
 * columns underneath encode four and the dashboard was rendering three.
 *
 *   sent           it went out, at that moment.
 *   failed         it was tried and did not go out; `error` is the reason.
 *   no-recipient   there was nobody to email. NOT a failure: an online guest who
 *                  left the optional checkout field blank, and every POS sale,
 *                  since the till captures no address anywhere in its flow.
 *   not-attempted  the send has not run yet, because it only runs on acceptance.
 *
 * THE LAST TWO WERE ONE STATE UNTIL NOW, AND THAT WAS A SMALL LIE. Task 7 read
 * "both columns null" as "nobody to email" and the table rendered an em-dash for
 * it — but a `pending` row has both columns null too, and it has not been tried:
 * `deliverFiscalDocumentEmail` is called from `persistAccepted` and nowhere
 * else. So every document still working its way through ETA displayed as though
 * the customer had declined to give an address. `status` is what tells them
 * apart, which is why this mapping needs the row and not just the two columns.
 *
 * A REJECTED OR PERMANENTLY-FAILED ROW STAYS `not-attempted` FOREVER, and that
 * is the honest reading rather than a gap: no copy was ever sent and none ever
 * will be, because there is no accepted document to send one of.
 *
 * ONE RESIDUAL AMBIGUITY, STATED. `deliverFiscalDocumentEmail` catches even its
 * own stamping failure (the database is then the thing that broke, and
 * acceptance still stands), so an accepted row whose stamp did not land reads as
 * `no-recipient`. Bounded and deliberate: the alternative is letting a failed
 * UPDATE roll back a filed tax document.
 */
export type SubmissionEmailState =
  | { kind: "sent"; at: Date }
  | { kind: "failed"; error: string }
  | { kind: "no-recipient" }
  | { kind: "not-attempted" };

/**
 * WHETHER THIS DOCUMENT WAS CAUGHT PAST ETA'S SUBMISSION WINDOW.
 *
 *   on-time         receipt family, never flagged.
 *   late            the worker claimed it past the window and told the owner
 *                   once, at `notifiedAt`.
 *   not-applicable  a family ETA publishes no submission deadline for — today
 *                   that is `e_invoice`. Rendering "on-time" for one would be
 *                   asserting it beat a deadline nobody has shown us; the third
 *                   state is what lets the table say nothing instead of saying
 *                   something unverified. See `isReceiptSubmissionWindowFamily`
 *                   and VERIFY-13.
 */
export type SubmissionLateState =
  | { kind: "on-time" }
  | { kind: "late"; notifiedAt: Date }
  | { kind: "not-applicable" };

export type SubmissionSideEffects = {
  email: SubmissionEmailState;
  late: SubmissionLateState;
};

/**
 * THE DERIVED SIDE-EFFECT VIEW: raw nullable columns in, named states out.
 *
 * ONE FUNCTION FOR BOTH EFFECTS, and they are grouped rather than merged. A
 * fiscal row accumulates side effects that are not lifecycle stages — the
 * customer was emailed, the owner was warned — each recorded as its own nullable
 * timestamp because none of them belongs on `status`. What they share is a
 * SHAPE, not a meaning: a small set of columns that only makes sense read
 * together, whose combinations mean different things, and whose reader is a
 * table cell. So they share a mapping function and keep separate unions.
 *
 * WHY IT LIVES HERE AND NOT IN THE COMPONENT. `FiscalSubmissionsTable` used to
 * hold this as a JSX ternary ladder — `customerEmailedAt ? … : customerEmailError
 * ? … : —` — which put a rule about what null MEANS inside a `.tsx` that no
 * harness in this repo can execute: the root suite is `environment: "node"` and
 * its include glob matches `.test.ts` only. The null semantics were therefore
 * asserted nowhere, and were documented only in a comment beside the markup.
 * Moved here they are ordinary data, tested as data (`read-model.test.ts`), and
 * the component's job shrinks to choosing a chip per named kind — which is what
 * made the missing fourth state visible at all.
 *
 * IT IS DASHBOARD-ONLY. Neither state reaches `SaleFiscalStatus`, so neither
 * reaches the till or `/order/[token]`. That containment is deliberate and is
 * the same line Task 7 drew for the columns themselves: these are owner-facing
 * operational facts about OUR pipeline, and `sideEffects.email.error` carries
 * `lastError`'s audience stance verbatim — an env KEY name is acceptable in it,
 * a VALUE never is — which is a trade made for one owner and not for whoever a
 * status link was forwarded to. `config-service.test.ts`'s masking walk covers
 * this object, with planted cases in the union's own `error` field.
 */
export function submissionSideEffects(row: {
  docType: EtaDocType;
  status: EtaSubmissionStatus;
  customerEmailedAt: Date | null;
  customerEmailError: string | null;
  lateNotifiedAt: Date | null;
}): SubmissionSideEffects {
  return {
    email: row.customerEmailedAt
      ? { kind: "sent", at: row.customerEmailedAt }
      : row.customerEmailError
        ? { kind: "failed", error: row.customerEmailError }
        // The send runs once, from `persistAccepted`. Before acceptance there is
        // nothing to report; after it, two null columns mean the recipient
        // ladder came back empty.
        : row.status === "accepted"
          ? { kind: "no-recipient" }
          : { kind: "not-attempted" },
    // ORDER MATTERS: the family gate comes FIRST. A stray `late_notified_at` on
    // an invoice — which nothing writes today, and which a future invoice
    // deadline would start writing — must not render as `late` until the family
    // is one this codebase claims a window for.
    late: !isReceiptSubmissionWindowFamily(row.docType)
      ? { kind: "not-applicable" }
      : row.lateNotifiedAt
        ? { kind: "late", notifiedAt: row.lateNotifiedAt }
        : { kind: "on-time" },
  };
}

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
  customerEmailedAt: etaSubmissions.customerEmailedAt,
  customerEmailError: etaSubmissions.customerEmailError,
  lateNotifiedAt: etaSubmissions.lateNotifiedAt,
} as const;

/**
 * The fiscal state of one sale, for the POS receipt (Task 7).
 *
 * `null` means this order has no fiscal row at all — a non-EG tenant, or a sale
 * whose enqueue has not landed yet. The POS renders no fiscal footer for it,
 * which is the country-gate's no-behavioural-change guarantee.
 *
 * BOTH SALE FAMILIES ARE ADMITTED (round 2, Task 5). A B2B sale is declared as
 * an `e_invoice` INSTEAD of an `e_receipt`, so the round-1 `docType =
 * 'e_receipt'` filter found nothing on those orders and this returned `null` —
 * indistinguishable, at the till, from a non-EG tenant, which meant a B2B
 * receipt printed no fiscal block at all with no error anywhere. No docType
 * predicate is used rather than an `in (...)` list, matching the sweep and
 * `requestB2bInvoice`'s pre-check: `eta_submissions_parent_xor` already
 * guarantees only `e_receipt` and `e_invoice` can carry an `order_id`.
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
 *
 * AN `e_invoice` HAS NO QR AND NEVER WILL, so "hold the image AND a terminal
 * status" is not a condition it can ever meet — a client applying the receipt's
 * rule to an invoice spends its whole polling budget re-reading a verdict it
 * already had. The till's predicate splits on `docType` for exactly that
 * (`apps/pos/src/fiscal/sale-fiscal.ts`, `isFiscalPollDone`).
 */
export async function getSaleFiscalStatus(
  tenantId: string,
  orderId: string,
): Promise<SaleFiscalStatus | null> {
  const row = await withTenant(tenantId, async (tx) => {
    const [found] = await tx
      .select({
        docType: etaSubmissions.docType,
        status: etaSubmissions.status,
        etaUuid: etaSubmissions.etaUuid,
        etaLongId: etaSubmissions.etaLongId,
        qrPayload: etaSubmissions.qrPayload,
      })
      .from(etaSubmissions)
      .where(
        and(
          eq(etaSubmissions.tenantId, tenantId),
          eq(etaSubmissions.orderId, orderId),
        ),
      )
      // ------------------------------------------------------------------
      // PRECEDENCE, STATED RATHER THAN LEFT TO THE SORT. Four rungs, each
      // deciding a question the one above it could not.
      //
      // THE MODEL RULE THIS SERVES: one sale is declared to ETA as ONE document
      // family — either an `e_receipt` or an `e_invoice`, never both. A
      // conforming order therefore has rows of a single family and rungs 1 and
      // 3 never fire. They exist for the ANOMALOUS order that carries both,
      // which nothing in the schema can prevent (the partial unique indexes are
      // keyed on (tenant, docType, order), so a receipt and an invoice for one
      // sale collide with nothing) and which is reachable only through the ONE
      // sanctioned family switch: every `e_receipt` rejected, then an invoice
      // issued in its place (`config-service.requestB2bInvoice`). Such an order
      // must resolve DETERMINISTICALLY and towards the document ETA actually
      // holds — never towards whichever row happened to sort first.
      //
      //   1. ACCEPTED FIRST. If ETA has accepted a document for this sale, that
      //      document is what the sale IS, whatever else exists beside it.
      //   2. LIVE BEFORE REJECTED. Within one family this is the correction
      //      rule: a rejection superseded by a corrected resubmission must show
      //      the correction, not the rejection it replaced. (Rung 1 never
      //      contradicts it — an accepted row is by definition not rejected.)
      //   3. THE `e_receipt` BREAKS A CROSS-FAMILY TIE. With two live,
      //      unaccepted rows of different families, the receipt is the older
      //      obligation and the one that already printed a QR for the customer;
      //      preferring it means the footer never silently swaps a printed QR
      //      for an invoice line while both are still pending.
      //   4. NEWEST, THEN ID. The residual total order, so the query is
      //      deterministic even where nothing above it discriminates.
      // ------------------------------------------------------------------
      .orderBy(
        sql`(${etaSubmissions.status} = 'accepted') desc`,
        sql`(${etaSubmissions.status} <> 'rejected') desc`,
        sql`(${etaSubmissions.docType} = 'e_receipt') desc`,
        desc(etaSubmissions.createdAt),
        desc(etaSubmissions.id),
      )
      .limit(1);
    return found ?? null;
  });

  if (!row) return null;
  // `eta_submissions_parent_xor` guarantees an `order_id` row is one of these
  // two, so the narrowing restates a database constraint rather than trusting
  // the column — and it is what keeps `SaleFiscalStatus.docType` a two-member
  // union the till can switch on exhaustively.
  const docType = row.docType === "e_invoice" ? "e_invoice" : "e_receipt";
  return {
    docType,
    status: row.status,
    etaUuid: row.etaUuid,
    etaLongId: row.etaLongId,
    qrPayload: row.qrPayload,
    qrImageDataUrl: row.qrPayload ? await QRCode.toDataURL(row.qrPayload) : null,
  };
}

/**
 * The SAME sale status, reached by the online customer's status token.
 *
 * WHO READS IT: `src/app/order/[token]/page.tsx`, whose audience is not a role
 * but "whoever holds the link". THE TOKEN IS THE AUTH and there is no second
 * one: `orders.status_token` is a unique random column handed to the customer at
 * checkout, and holding it is already what authorises seeing that order's items,
 * totals and delivery address on that page. The fiscal identity of the same sale
 * is not a wider fact than those, so this adds no permission surface — no role
 * check, no session, deliberately.
 *
 * IT DELEGATES; IT DOES NOT QUERY. `getSaleFiscalStatus` above owns the widened
 * both-families lookup AND the four-rung precedence, and this function runs
 * neither of its own — it resolves the token to an order id and calls it. That
 * is a rule rather than a convenience. A second query here would be the
 * storefront quietly re-acquiring the `docType = 'e_receipt'` blindness the read
 * model shed in round 2 Task 5: a B2B order would come back `null`, and `null`
 * on this page means "nothing filed yet", so a business customer's tax invoice
 * would render as a pending consumer receipt with no error anywhere. A second
 * ORDER BY would be a second answer to "which document IS this sale" on an
 * anomalous both-family order, with nothing keeping the two in step.
 *
 * `null` COVERS EVERY MISS IDENTICALLY — no such token, another tenant's token,
 * a real order with no fiscal row yet. The page renders the same thing for all
 * three, and collapsing them is what stops a caller probing tokens from telling
 * "wrong token" apart from "right token, nothing filed".
 *
 * WHAT IT MAY RETURN, and why it is this function and not one of the dashboard
 * reads. `listSubmissions` and `getSubmissionById` both carry `lastError`, which
 * is worker-written free text that legitimately names an env KEY (see
 * `resolveSecretRef`) — a trade made for a surface gated on `fiscal:manage`, one
 * owner. This function selects no such column: `SaleFiscalStatus` is the
 * document's own identity and nothing else. Reaching for either of the other two
 * here, to show the customer "why", would hand a deployment's variable names to
 * anyone the link was forwarded to. `config-service.test.ts`'s masking walk
 * holds this surface to a STRICTER forbidden set than the dashboard's for
 * exactly that reason.
 *
 * `getOrderByToken` IS IMPORTED DYNAMICALLY, mirroring `./finalize`'s dynamic
 * `./sign-invoice` import. `@/server/ordering/service` pulls entitlements,
 * inventory, catalog, payments, realtime and the WhatsApp queue onto whatever
 * imports it, and this module sits on the graph of every POS fiscal read and
 * every dashboard fiscal page — none of which will ever take this branch.
 *
 * HOW MUCH THAT ACTUALLY BUYS, stated honestly rather than overclaimed. It buys
 * nothing for THIS function's own caller: `/order/[token]/page.tsx` already
 * imports `@/server/ordering/service` statically for `getOrderByToken`, so on
 * the one path that reaches here the graph is loaded either way. The benefit
 * accrues entirely to the module's OTHER importers — the till's fiscal status
 * read, the dashboard's submissions page — which would otherwise pay for a
 * dependency they never call. That is still worth the dynamic import, but it is
 * a benefit to bystanders rather than to the code the import sits in.
 */
export async function getSaleFiscalStatusByToken(
  tenantId: string,
  token: string,
): Promise<SaleFiscalStatus | null> {
  const { getOrderByToken } = await import("@/server/ordering/service");
  // Tenant-scoped by the `withTenant` inside it, so another tenant's token
  // resolves to nothing rather than to their order — RLS, not a WHERE clause we
  // could forget.
  const order = await getOrderByToken(tenantId, token);
  if (!order) return null;
  return getSaleFiscalStatus(tenantId, order.id);
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

  return { rows: rows.slice(0, limit).map((row) => toRowView(row, now)), hasMore: rows.length > limit };
}

/**
 * The raw column shape both reads select — the input side of `toRowView`, stated
 * as the view MINUS what is derived PLUS what is derived FROM. Spelling it this
 * way rather than listing eleven columns again keeps the two ends of the mapping
 * from drifting: a column added to `SUBMISSION_ROW_COLUMNS` and to the view needs
 * no edit here, while one that feeds a derived state has to be named.
 */
type SubmissionRowColumns = Omit<SubmissionRowView, "overdue" | "sideEffects"> & {
  customerEmailedAt: Date | null;
  customerEmailError: string | null;
  lateNotifiedAt: Date | null;
};

/**
 * Raw columns → what the dashboard renders: the 24-hour-window verdict, plus the
 * named side-effect states.
 *
 * ONE MAPPER FOR BOTH READS. `listSubmissions` and `getSubmissionById` show the
 * same table cells, so a second derivation would be a second answer to "is this
 * row late" that nothing keeps in step — the same reason the two share
 * `SUBMISSION_ROW_COLUMNS`.
 *
 * THE OVERDUE RULE. `accepted` is the only status that closes the obligation — a
 * `rejected` or `failed` document past the window is still a receipt ETA never
 * accepted, and hiding that behind "it is terminal" is exactly the reporting gap
 * addendum §3 asks to close ("retry/backoff must respect the 24h budget and flag
 * breaches"). The worker deliberately does not REFUSE past the deadline, because
 * giving up at it would turn a late document into no document; flagging here is
 * the other half of that decision, and the worker's own late notify (round 2
 * Task 8) is the third.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK ORIGIN IS `createdAt`, AND IT IS NOT ALWAYS `dateTimeIssued`.
 * ETA's window runs from the moment the document says it was issued; this
 * derivation runs from the moment ServeOS wrote the row. For a POS sale those
 * are seconds apart against a 24-hour budget. For a SWEPT ONLINE ORDER — the
 * online channel's primary path, since `reconcileMissingReceipts` adopts orders
 * the enqueue never covered — `createdAt` TRAILS `dateTimeIssued` by anything
 * from ~5 minutes up to `RECONCILE_HORIZON_MS` (7 days).
 *
 * WHAT THAT COSTS, EXACTLY: a backlog-adopted row reads on-time (and not
 * overdue) for its first 24 hours even though ETA's clock started days earlier,
 * so the flag arrives late for a document that was already late. BOUNDED BY THE
 * SWEEP HORIZON and accepted rather than fixed: the alternative is parsing
 * `dateTimeIssued` out of `request_json` on every read of every row, for a
 * correction that only affects rows adopted from the backlog — and a row that
 * sat unfiled for days has a larger problem than the timing of its chip. Stated
 * here, at the derivation, so it is read by whoever next wonders why an old
 * order's document looks fresh.
 */
function toRowView(row: SubmissionRowColumns, now: number): SubmissionRowView {
  // THE THREE RAW COLUMNS ARE DROPPED, not carried alongside their derived
  // states. Returning both would leave two representations of one fact on the
  // same object, and the next cell that needed "was it emailed?" would read the
  // nullable pair directly and re-invent the semantics this view exists to own —
  // which is exactly how the not-attempted state got lost the first time.
  const { customerEmailedAt: _at, customerEmailError: _error, lateNotifiedAt: _late, ...rest } = row;
  return {
    ...rest,
    overdue: row.status !== "accepted" && now - row.createdAt.getTime() > SUBMISSION_WINDOW_MS,
    sideEffects: submissionSideEffects(row),
  };
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
    return row ? toRowView(row, Date.now()) : null;
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
