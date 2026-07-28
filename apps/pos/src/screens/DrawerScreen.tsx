import { useCallback, useEffect, useState } from "react";
import { CashMovementModal } from "./CashMovementModal";
import { CloseDrawerModal } from "./CloseDrawerModal";
import { OpenDrawerScreen } from "./OpenDrawerScreen";
import { formatAmount, parseAmount } from "../drawer/counting";
import type { CashMovementType, PosShiftSummary, ShiftReport } from "../../electron/pos-main";

const MOVEMENTS: { type: CashMovementType; label: string }[] = [
  { type: "pay_in", label: "Pay in" },
  { type: "pay_out", label: "Pay out" },
  { type: "safe_drop", label: "Safe drop" },
  { type: "no_sale", label: "No sale" },
];

/**
 * The drawer tab: the live X-report plus everything a cashier does to the
 * drawer. Re-reading the report is free — the server records nothing and never
 * resets it — so it refreshes after every action.
 */
export function DrawerScreen({ branchName, onChanged }: { branchName: string; onChanged?: () => void }) {
  const [shift, setShift] = useState<PosShiftSummary | null>(null);
  const [report, setReport] = useState<ShiftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [movement, setMovement] = useState<CashMovementType | null>(null);
  const [closing, setClosing] = useState(false);
  const [counting, setCounting] = useState(false);
  const [countValue, setCountValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((s: PosShiftSummary | null, r: ShiftReport | null) => {
    setShift(s);
    setReport(r);
    setLoading(false);
    onChanged?.();
  }, [onChanged]);

  // The read is asynchronous on purpose: settling state inside the promise keeps
  // the effect itself free of synchronous setState.
  useEffect(() => {
    window.pos.currentShift().then(({ shift: s, report: r }) => apply(s, r));
  }, [apply]);

  async function refresh() {
    const { shift: s, report: r } = await window.pos.currentShift();
    apply(s, r);
  }

  if (loading) {
    return <div className="grid place-items-center py-24 text-sm text-muted-foreground">Loading drawer…</div>;
  }

  if (!shift || !report) {
    return (
      <OpenDrawerScreen branchName={branchName} onOpened={() => { void refresh(); }} />
    );
  }

  async function recordCount() {
    const amount = parseAmount(countValue);
    if (amount === null) return;
    const res = await window.pos.countDrawer(amount);
    setCounting(false);
    setCountValue("");
    setNotice(res.ok ? "Count recorded. The drawer stays open." : res.message);
    if (res.ok) void refresh();
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-display text-xl font-bold text-ink">Drawer</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {branchName} — open since {new Date(report.openedAt).toLocaleTimeString()}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Expected cash</p>
            <p className="font-display text-2xl font-bold text-ink">
              {report.cash.expected === null ? "—" : formatAmount(report.cash.expected)}
            </p>
          </div>
        </div>

        <dl className="mt-5 space-y-2 text-sm">
          <Row label="Opening float" value={formatAmount(report.openingFloat)} />
          {report.tenders.map((t) => (
            <Row key={t.method} label={`${t.method} taken (${t.count})`} value={formatAmount(t.amount)} />
          ))}
          <Row label="Sales" value={String(report.salesCount)} />
          {report.discountTotal > 0 && <Row label="Discounts" value={formatAmount(report.discountTotal)} />}
          {report.movements.map((m) => (
            <Row key={m.type} label={`${m.type.replace(/_/g, " ")} (${m.count})`} value={formatAmount(m.total)} />
          ))}
        </dl>

        {report.cash.expected === null && (
          <p className="mt-4 text-sm text-muted-foreground">
            Expected cash is hidden on this till. Count the drawer and a manager can review it.
          </p>
        )}

        <div className="mt-6 grid grid-cols-2 gap-2">
          {MOVEMENTS.map((m) => (
            <button
              key={m.type}
              onClick={() => setMovement(m.type)}
              className="rounded-xl border border-border bg-card px-4 py-3 font-semibold text-ink hover:bg-secondary"
            >
              {m.label}
            </button>
          ))}
        </div>

        {counting ? (
          <div className="mt-4 rounded-xl border border-border bg-background p-3">
            <label className="block text-sm font-medium text-ink" htmlFor="mid-count">Counted total</label>
            <input
              id="mid-count"
              type="number"
              step="0.01"
              min={0}
              autoFocus
              inputMode="decimal"
              value={countValue}
              onChange={(e) => setCountValue(e.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-3 text-base"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => { setCounting(false); setCountValue(""); }}
                className="flex-1 rounded-xl border border-border px-4 py-2 font-semibold text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => { void recordCount(); }}
                disabled={parseAmount(countValue) === null}
                className="flex-1 rounded-xl bg-primary px-4 py-2 font-semibold text-primary-foreground disabled:opacity-50"
              >
                Record count
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              onClick={() => setCounting(true)}
              className="rounded-xl border border-border bg-card px-4 py-3 font-semibold text-ink hover:bg-secondary"
            >
              Count drawer
            </button>
            <button
              onClick={() => setClosing(true)}
              className="rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground"
            >
              Close drawer
            </button>
          </div>
        )}

        {notice && <p className="mt-4 text-sm text-muted-foreground">{notice}</p>}
      </div>

      {movement && (
        <CashMovementModal
          type={movement}
          onDone={() => { setMovement(null); void refresh(); }}
          onCancel={() => setMovement(null)}
        />
      )}
      {closing && (
        <CloseDrawerModal
          onClosed={() => { setClosing(false); void refresh(); }}
          onCancel={() => setClosing(false)}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="capitalize text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  );
}
