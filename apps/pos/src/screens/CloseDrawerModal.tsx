import { useState, type FormEvent } from "react";
import { ManagerAuthModal } from "./ManagerAuthModal";
import { DenominationPad } from "../drawer/DenominationPad";
import { compactDenominations, denominationsAgree, formatAmount, parseAmount, varianceLabel } from "../drawer/counting";
import type { ShiftReport } from "../../electron/pos-main";

/**
 * Counting the drawer closed.
 *
 * The cashier states what they counted; everything else — expected, variance,
 * whether it is flagged — comes back from the server. Under blind close the
 * server returns those as null and this simply does not show them: the till
 * never derives a number it was deliberately not told.
 */
export function CloseDrawerModal({
  onClosed,
  onCancel,
}: {
  onClosed: () => void;
  onCancel: () => void;
}) {
  const [counted, setCounted] = useState("");
  const [denominations, setDenominations] = useState<Record<string, number>>({});
  const [showPad, setShowPad] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsManager, setNeedsManager] = useState(false);
  const [report, setReport] = useState<ShiftReport | null>(null);

  const amount = parseAmount(counted);
  const pad = compactDenominations(denominations);
  const padUsed = Object.keys(pad).length > 0;
  const padDisagrees = padUsed && amount !== null && !denominationsAgree(pad, amount);

  async function close(grant?: string) {
    if (amount === null) {
      setError("Enter the amount you counted");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.pos.closeShift(amount, padUsed ? pad : undefined, grant);
    setBusy(false);

    if (res.ok) {
      setReport(res.data.report);
      return;
    }
    if (res.code === "needs_manager") {
      setNeedsManager(true);
      return;
    }
    setError(res.message);
  }

  if (needsManager) {
    return (
      <ManagerAuthModal
        permission="reconciliation:manage"
        action="Approve closing this drawer"
        onGranted={(grant) => {
          setNeedsManager(false);
          void close(grant);
        }}
        onCancel={() => {
          setNeedsManager(false);
          setError("A manager must approve this close");
        }}
      />
    );
  }

  // The Z-report. `expected` and `variance` are absent under a blind close.
  if (report) {
    const blind = report.cash.expected === null;
    const variance = report.cash.variance ?? null;
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-bold text-ink">Drawer closed</h2>

          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Counted" value={formatAmount(report.cash.counted ?? 0)} />
            {!blind && <Row label="Expected" value={formatAmount(report.cash.expected!)} />}
            {!blind && variance !== null && (
              <Row
                label="Variance"
                value={`${formatAmount(variance)} (${varianceLabel(variance)})`}
                emphasis={varianceLabel(variance) !== "balanced"}
              />
            )}
            <Row label="Sales" value={String(report.salesCount)} />
            {report.tenders.map((t) => (
              <Row key={t.method} label={`${t.method} (${t.count})`} value={formatAmount(t.amount)} />
            ))}
          </dl>

          {blind && (
            <p className="mt-4 text-sm text-muted-foreground">
              The count is recorded. A manager can see the expected total and variance.
            </p>
          )}
          {report.flagged && (
            <p className="mt-3 text-sm text-destructive">This drawer is flagged for review.</p>
          )}

          <button
            onClick={onClosed}
            className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (padDisagrees) {
      setError("The notes you counted do not add up to the total");
      return;
    }
    void close();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold text-ink">Close the drawer</h2>
        <p className="mt-1 text-sm text-muted-foreground">Count the cash in the drawer and enter the total.</p>

        <label className="mt-5 block text-sm font-medium text-ink" htmlFor="counted-total">Counted total</label>
        <input
          id="counted-total"
          type="number"
          step="0.01"
          min={0}
          autoFocus
          inputMode="decimal"
          value={counted}
          onChange={(e) => setCounted(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        <button type="button" onClick={() => setShowPad((s) => !s)} className="mt-3 text-sm font-medium text-primary">
          {showPad ? "Hide note breakdown" : "Count it note by note"}
        </button>
        {showPad && <DenominationPad value={denominations} onChange={setDenominations} />}

        {padDisagrees && (
          <p className="mt-3 text-sm text-destructive">The notes counted do not add up to the total.</p>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-xl border border-border bg-card px-4 py-3 font-semibold text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || amount === null}
            className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Closing…" : "Close drawer"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={emphasis ? "font-semibold text-destructive" : "font-semibold text-ink"}>{value}</dd>
    </div>
  );
}
