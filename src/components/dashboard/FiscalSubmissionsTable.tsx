import { formatDayTime } from "@/lib/datetime";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SubmissionRowView, SubmissionStatusCounts } from "@/server/fiscal/read-model";
import type { EtaSubmissionStatus } from "@/server/fiscal/schema";
import {
  EMAIL_MARKER, LATE_MARKER, OVERDUE_MARKER, STATUS_CHIP,
  TIER_CHIP_CLS, TIER_MARKER_CLS, type SubmissionMarker,
} from "./fiscal-chips";

/**
 * The ETA submission feed: a status summary over the WHOLE table, then the
 * newest page of documents, with a resubmit control on the rows that can take
 * one.
 *
 * Entirely props-driven — the `import type`s are erased at compile time and emit
 * nothing, and `./fiscal-chips` is a plain `.ts` of tokens, so this file pulls no
 * server module into the component tree. It takes its server action as a prop for
 * the same reason: the component decides WHERE the button goes, the page decides
 * WHAT it does.
 *
 * IT RENDERS NAMED STATES, IT DOES NOT DERIVE THEM (round 2, Task 8). The email
 * cell used to be a ternary ladder over two nullable columns — a rule about what
 * null MEANS, living in a file no harness in this repo can execute. That mapping
 * now lives in `read-model.ts`'s `submissionSideEffects` and arrives here as
 * `row.sideEffects.{email,late}`, each a discriminated union; this file's whole
 * remaining job is choosing a token per `kind`. Moving it is what surfaced the
 * fourth email state the ladder had been collapsing (`not-attempted` vs
 * `no-recipient`), which is the argument for the split in one sentence.
 */

/**
 * How long ago, coarsely — the question this column answers is "is this close
 * to ETA's 24-hour window", not "when exactly", which the When column already
 * gives to the minute.
 */
function formatAge(at: Date): string {
  const minutes = Math.max(0, Math.floor((Date.now() - at.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function StatusChip({ status, children }: { status: EtaSubmissionStatus; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TIER_CHIP_CLS[STATUS_CHIP[status]]}`}
    >
      {children}
    </span>
  );
}

/** The dense annotation form: a flag attached to the value beside it (an age, a
 *  send time), not a state of its own. `title` is overridable so the email
 *  failure can carry its own reason while sharing the token. */
function Marker({ marker, title }: { marker: SubmissionMarker; title?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${TIER_MARKER_CLS[marker.tier]}`}
      title={title ?? marker.title}
    >
      {marker.label}
    </span>
  );
}

export function FiscalSubmissionsTable({
  rows,
  hasMore,
  counts,
  timezone,
  resubmitAction,
  pageSize,
}: {
  rows: SubmissionRowView[];
  hasMore: boolean;
  /** Counts over every document the tenant holds, NOT over `rows` — a page of
   *  "newest first" says nothing about last Tuesday's rejections, which are
   *  exactly what this summary exists to surface. */
  counts: SubmissionStatusCounts;
  timezone: string;
  resubmitAction: (formData: FormData) => Promise<void | { error: string }>;
  pageSize: number;
}) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* Zero-filled and in a fixed order: a chip row that appeared and
            disappeared as documents moved between states would be unreadable,
            and "rejected 0" is a materially different thing to be told than
            nothing at all. */}
        {(Object.keys(counts) as (keyof SubmissionStatusCounts)[]).map((status) => (
          <StatusChip key={status} status={status}>
            <span className="tabular-nums font-semibold">{counts[status]}</span>
            {status}
          </StatusChip>
        ))}
        <span className="text-xs text-muted-foreground">
          {total === 1 ? "1 document" : `${total} documents`}
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No submissions yet"
          description="Fiscal documents appear here as sales and refunds are rung."
        />
      ) : (
        <Card className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Age</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>ETA uuid</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Notified</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {formatDayTime(row.createdAt, timezone)}
                  </TableCell>
                  {/* Age + the overdue marker. ETA gives 24 hours from
                      issuance to submit a receipt; past that a document needs a
                      formal Late Submission Request, which nothing here can do
                      for the owner — so the one useful thing the dashboard can
                      offer is to stop it being a surprise. */}
                  <TableCell className="whitespace-nowrap text-xs">
                    <span className={row.overdue ? "font-medium text-red-700 dark:text-red-400" : "text-muted-foreground"}>
                      {formatAge(row.createdAt)}
                    </span>
                    {row.overdue && (
                      <span className="ml-1.5">
                        <Marker marker={OVERDUE_MARKER} />
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.docType}
                    {/* A refund of a B2B-invoiced sale (issueRefund step 10):
                        the row records that a credit note is OWED — ServeOS
                        does not build or submit one yet, so it stays pending. */}
                    {row.docType === "credit_note" && (
                      <span className="block font-medium text-amber-700 dark:text-amber-400">
                        credit note required — not filed automatically
                      </span>
                    )}
                    {row.referenceOldUuid && (
                      <span className="block text-muted-foreground">
                        correction of {row.referenceOldUuid.slice(0, 12)}…
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={row.status}>{row.status}</StatusChip>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {row.etaUuid ? `${row.etaUuid.slice(0, 12)}…` : "—"}
                  </TableCell>
                  <TableCell className="text-xs">{row.attempts}</TableCell>
                  {/* WHO WAS TOLD WHAT — the two side-effect records, stacked in
                      ONE cell rather than given a column each.

                      THE HOLISTIC TOUCH THE REVIEWS ASKED FOR, and it is a
                      column NOT added. This table was already at nine columns
                      and a tenth for the late flag would have been a whole
                      column that is empty on all but a handful of rows ever —
                      cost paid by every row, value delivered to almost none.
                      What the two records share is not a subject (one is the
                      customer's copy, one is an owner alert) but a KIND: both
                      are things that happened ALONGSIDE the filing and neither
                      is a lifecycle stage, which is exactly the framing
                      `late_notified_at` was given at the schema — "an orthogonal
                      side-effect record, like `customer_emailed_at`". Grouping
                      them says that in the layout.

                      THE `overdue` MARKER DELIBERATELY STAYS IN THE AGE CELL. It
                      is not a side effect and nothing emitted it: it is the age
                      beside it, read against a deadline. Putting it here would
                      have grouped by mood rather than by meaning, and would have
                      separated it from the only number that explains it.

                      Line one, the CUSTOMER's copy — four named states, the
                      em-dash a real answer rather than a blank. For an ONLINE
                      order this email is the customer's primary copy of the QR
                      (the status page's fiscal block is written 5-20 minutes
                      after payment, so it is what a revisit shows), which is why
                      a failure belongs on the screen an owner already watches
                      instead of only in the logs. `failed` carries its reason in
                      the tooltip — the SAME owner-audience text as `lastError`
                      beside it: an env key name may appear in it, a secret value
                      never can.

                      Line two, the OWNER's late alert, rendered only when there
                      is one. */}
                  <TableCell className="whitespace-nowrap text-xs">
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground">
                        {row.sideEffects.email.kind === "sent" ? (
                          formatDayTime(row.sideEffects.email.at, timezone)
                        ) : row.sideEffects.email.kind === "failed" ? (
                          <Marker marker={EMAIL_MARKER.failed} title={row.sideEffects.email.error} />
                        ) : row.sideEffects.email.kind === "no-recipient" ? (
                          <span title="No address to send to — a guest who left the optional checkout field blank, or a till sale (the POS captures no address).">—</span>
                        ) : (
                          <span title="The customer's copy is sent when ETA accepts the document; this one has not been accepted yet.">not sent yet</span>
                        )}
                      </span>
                      {row.sideEffects.late.kind === "late" && (
                        <span>
                          <Marker marker={LATE_MARKER.late} />
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground max-w-xs truncate" title={row.lastError ?? ""}>
                    {row.lastError ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Only a REJECTED document with an ETA uuid can be
                        superseded: ETA does not accept a fix in place, and a
                        rejection that never reached ETA has no uuid for a
                        correction to reference. */}
                    {row.status === "rejected" && row.etaUuid && (
                      <ToastForm action={resubmitAction} successMessage="Correction queued">
                        <input type="hidden" name="submissionId" value={row.id} />
                        <SubmitButton size="sm" variant="ghost">Resubmit</SubmitButton>
                      </ToastForm>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {hasMore && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the {pageSize} most recent documents.
        </p>
      )}
    </>
  );
}
