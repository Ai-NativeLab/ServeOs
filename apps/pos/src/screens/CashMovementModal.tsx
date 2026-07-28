import { useState, type FormEvent } from "react";
import { ManagerAuthModal } from "./ManagerAuthModal";
import { parseAmount } from "../drawer/counting";
import type { CashMovementType } from "../../electron/pos-main";

const REASONS: Record<CashMovementType, { label: string; reasons: string[] }> = {
  pay_in: { label: "Pay in", reasons: ["float_top_up", "change_fund", "other"] },
  pay_out: { label: "Pay out", reasons: ["supplier", "petty_cash", "refund_cash", "other"] },
  safe_drop: { label: "Safe drop", reasons: ["drop", "end_of_shift", "other"] },
  no_sale: { label: "No sale", reasons: ["change_given", "drawer_check", "other"] },
};

/**
 * Cash in or out of the drawer outside a sale. The cashier always enters a
 * positive amount — the sign is the server's business, so the stored value, the
 * DB check and the expected-cash formula cannot disagree about direction.
 *
 * A pay-out above the tenant's threshold comes back 403; that is the cue to ask
 * a manager, not an error to show the cashier.
 */
export function CashMovementModal({
  type,
  onDone,
  onCancel,
}: {
  type: CashMovementType;
  onDone: () => void;
  onCancel: () => void;
}) {
  const spec = REASONS[type];
  const isNoSale = type === "no_sale";
  const [amount, setAmount] = useState(isNoSale ? "0" : "");
  const [reasonCode, setReasonCode] = useState(spec.reasons[0]);
  const [reasonText, setReasonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsManager, setNeedsManager] = useState(false);

  const value = isNoSale ? 0 : parseAmount(amount);

  async function record(grant?: string) {
    if (value === null) {
      setError("Enter an amount");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.pos.cashMovement({
      type, amount: value, reasonCode, reasonText: reasonText.trim() || undefined, grant,
    });
    setBusy(false);

    if (res.ok) {
      onDone();
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
        action={`Approve a ${spec.label.toLowerCase()} of ${amount}`}
        onGranted={(grant) => {
          setNeedsManager(false);
          void record(grant);
        }}
        onCancel={() => {
          setNeedsManager(false);
          setError("A manager must approve this amount");
        }}
      />
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void record();
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h2 className="text-lg font-bold text-ink">{spec.label}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {isNoSale
            ? "Opens the drawer without moving any cash. It is still recorded."
            : "Enter the amount as a positive number."}
        </p>

        {!isNoSale && (
          <>
            <label className="mt-5 block text-sm font-medium text-ink" htmlFor="movement-amount">Amount</label>
            <input
              id="movement-amount"
              type="number"
              step="0.01"
              min={0}
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
            />
          </>
        )}

        <label className="mt-4 block text-sm font-medium text-ink" htmlFor="movement-reason">Reason</label>
        <select
          id="movement-reason"
          value={reasonCode}
          onChange={(e) => setReasonCode(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        >
          {spec.reasons.map((r) => (
            <option key={r} value={r}>{r.replace(/_/g, " ")}</option>
          ))}
        </select>

        <label className="mt-4 block text-sm font-medium text-ink" htmlFor="movement-note">Note (optional)</label>
        <input
          id="movement-note"
          value={reasonText}
          onChange={(e) => setReasonText(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

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
            disabled={busy || (!isNoSale && value === null)}
            className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Recording…" : spec.label}
          </button>
        </div>
      </form>
    </div>
  );
}
