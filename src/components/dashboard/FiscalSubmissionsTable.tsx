import { formatDayTime } from "@/lib/datetime";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { SubmitButton } from "@/components/dashboard/SubmitButton";
import { ToastForm } from "@/components/dashboard/ToastForm";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SubmissionRowView, SubmissionStatusCounts } from "@/server/fiscal/read-model";

/**
 * The ETA submission feed: a status summary over the WHOLE table, then the
 * newest page of documents, with a resubmit control on the rows that can take
 * one.
 *
 * Entirely props-driven — the two `import type`s are erased at compile time and
 * emit nothing, so this file pulls no server module into the component tree. It
 * takes its server action as a prop for the same reason: the component decides
 * WHERE the button goes, the page decides WHAT it does.
 */

/** `rejected` and `failed` are the two rows an owner opens this screen to find,
 *  so they read as warnings rather than as neutral state. */
const STATUS_CHIP: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  submitted: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  accepted: "bg-green-500/10 text-green-700 dark:text-green-400",
  rejected: "bg-red-500/10 text-red-700 dark:text-red-400",
  failed: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

function StatusChip({ status, children }: { status: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_CHIP[status] ?? ""}`}
    >
      {children}
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
                <TableHead>Document</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>ETA uuid</TableHead>
                <TableHead>Attempts</TableHead>
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
                  <TableCell className="text-xs">
                    {row.docType}
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
