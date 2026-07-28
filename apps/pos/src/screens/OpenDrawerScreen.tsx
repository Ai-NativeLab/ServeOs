import { useState, type FormEvent } from "react";
import { DenominationPad } from "../drawer/DenominationPad";
import { compactDenominations, denominationsAgree, parseAmount } from "../drawer/counting";

/**
 * Offered after sign-in, and skippable on purpose: a drawer is only required to
 * take CASH. Card-only selling is legitimate without one, and the server refuses
 * a cash tender with no open drawer, so nothing can slip through unaccounted.
 */
export function OpenDrawerScreen({
  branchName,
  onOpened,
  onSkip,
}: {
  branchName: string;
  onOpened: () => void;
  onSkip?: () => void;
}) {
  const [float, setFloat] = useState("");
  const [denominations, setDenominations] = useState<Record<string, number>>({});
  const [showPad, setShowPad] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const amount = parseAmount(float);
  const counted = compactDenominations(denominations);
  const padUsed = Object.keys(counted).length > 0;
  const padDisagrees = padUsed && amount !== null && !denominationsAgree(counted, amount);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (amount === null) {
      setError("Enter the opening float");
      return;
    }
    if (padDisagrees) {
      setError("The notes you counted do not add up to the float");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.pos.openShift(amount, padUsed ? counted : undefined);
    setBusy(false);
    if (res.ok) onOpened();
    else setError(res.message);
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
        <h1 className="font-display text-xl font-bold text-ink">Open the drawer</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {branchName} — count the cash you are starting with.
        </p>

        <label className="mt-5 block text-sm font-medium text-ink" htmlFor="opening-float">Opening float</label>
        <input
          id="opening-float"
          type="number"
          step="0.01"
          min={0}
          autoFocus
          inputMode="decimal"
          value={float}
          onChange={(e) => setFloat(e.target.value)}
          className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-3 text-base"
        />

        <button
          type="button"
          onClick={() => setShowPad((s) => !s)}
          className="mt-3 text-sm font-medium text-primary"
        >
          {showPad ? "Hide note breakdown" : "Count it note by note"}
        </button>
        {showPad && <DenominationPad value={denominations} onChange={setDenominations} />}

        {padDisagrees && (
          <p className="mt-3 text-sm text-destructive">
            The notes counted do not add up to the float.
          </p>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={busy || amount === null}
          className="mt-5 w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open drawer"}
        </button>

        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="mt-2 w-full rounded-xl border border-border bg-card px-4 py-3 font-semibold text-muted-foreground"
          >
            Skip — card sales only
          </button>
        )}
      </form>
    </div>
  );
}
