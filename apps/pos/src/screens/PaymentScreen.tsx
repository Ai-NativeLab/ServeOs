import { useState } from "react";

export type TenderMethod = "cash" | "card" | "other";
export type TenderDraft = {
  method: TenderMethod;
  amount: number;
  tenderedAmount?: number;
  reference?: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What is still owed. Never negative. */
export function splitRemaining(total: number, tenders: TenderDraft[]): number {
  const paid = round2(tenders.reduce((s, t) => s + t.amount, 0));
  return Math.max(0, round2(total - paid));
}

/** Only cash gives change. */
export function changeFor(tender: TenderDraft): number {
  if (tender.method !== "cash" || tender.tenderedAmount === undefined) return 0;
  return Math.max(0, round2(tender.tenderedAmount - tender.amount));
}

/** Quick-cash chips: exact, then the next round notes above it. */
function cashChips(remaining: number): number[] {
  const notes = [5, 10, 20, 50, 100, 200];
  const up = notes.filter((n) => n >= remaining).slice(0, 3);
  return [remaining, ...up.filter((n) => n !== remaining)];
}

export function PaymentScreen({
  total,
  cashierName,
  onCancel,
  onComplete,
}: {
  total: number;
  cashierName: string;
  onCancel: () => void;
  onComplete: (tenders: TenderDraft[]) => Promise<void>;
}) {
  const [tenders, setTenders] = useState<TenderDraft[]>([]);
  const [method, setMethod] = useState<TenderMethod>("cash");
  const [entry, setEntry] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remaining = splitRemaining(total, tenders);
  const paid = round2(total - remaining);
  const change = round2(tenders.reduce((s, t) => s + changeFor(t), 0));
  const entered = Number(entry || 0);

  function addTender(handedOver: number) {
    // A cash tender may exceed what is due (that is what change IS). A card
    // tender may not — the amount applied is capped at what remains.
    const applied = method === "cash" ? Math.min(handedOver, remaining) : handedOver;
    if (applied <= 0) return;
    if (method !== "cash" && applied > remaining + 0.001) {
      setError("Only cash can be over-tendered — a card must not exceed what is due");
      return;
    }
    setError(null);
    setTenders([
      ...tenders,
      {
        method,
        amount: round2(applied),
        tenderedAmount: method === "cash" ? round2(handedOver) : undefined,
        reference: method !== "cash" && reference.trim() ? reference.trim() : undefined,
      },
    ]);
    setEntry("");
    setReference("");
  }

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      await onComplete(tenders);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete the sale");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background px-4 py-6">
      <div className="mx-auto grid w-full max-w-3xl gap-4 md:grid-cols-2">
        <section className="rounded-2xl border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">Amount due</p>
          <p className="mt-1 text-4xl font-bold tabular-nums text-ink">{total.toFixed(2)}</p>

          <dl className="mt-5 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Paid so far</dt>
              <dd className="tabular-nums text-ink">{paid.toFixed(2)}</dd>
            </div>
            <div className="flex justify-between font-semibold">
              <dt className={remaining > 0 ? "text-destructive" : "text-ink"}>Remaining</dt>
              <dd className={remaining > 0 ? "tabular-nums text-destructive" : "tabular-nums text-ink"}>
                {remaining.toFixed(2)}
              </dd>
            </div>
            {change > 0 && (
              <div className="flex justify-between font-semibold">
                <dt className="text-ink">Change due</dt>
                <dd className="tabular-nums text-ink">{change.toFixed(2)}</dd>
              </div>
            )}
          </dl>

          {tenders.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-dashed border-border pt-3 text-sm">
              {tenders.map((t, i) => (
                <li key={i} className="flex justify-between text-muted-foreground">
                  <span className="capitalize">{t.method}</span>
                  <span className="tabular-nums">{t.amount.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}

          {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        </section>

        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex gap-2">
            {(["cash", "card", "other"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={m === method
                  ? "flex-1 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold capitalize text-primary-foreground"
                  : "flex-1 rounded-xl border border-border px-3 py-2.5 text-sm font-medium capitalize text-ink"}
              >
                {m}
              </button>
            ))}
          </div>

          {remaining > 0 && method === "cash" && (
            <div className="mt-4 flex flex-wrap gap-2">
              {cashChips(remaining).map((c) => (
                <button
                  key={c}
                  onClick={() => addTender(c)}
                  className="rounded-lg border border-border px-3 py-2 text-sm font-medium tabular-nums text-ink"
                >
                  {c.toFixed(2)}
                </button>
              ))}
            </div>
          )}

          <input
            inputMode="decimal"
            value={entry}
            onChange={(e) => setEntry(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            aria-label="Tender amount"
            className="mt-4 w-full rounded-xl border border-border bg-background px-3 py-3 text-right text-2xl tabular-nums"
          />

          {method !== "cash" && (
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Reference (card last 4)"
              aria-label="Payment reference"
              className="mt-2 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm"
            />
          )}

          <button
            onClick={() => addTender(entered)}
            disabled={remaining <= 0 || entered <= 0}
            className="mt-3 w-full rounded-xl border border-border px-4 py-3 font-semibold text-ink disabled:opacity-40"
          >
            Add {method} tender
          </button>

          <div className="mt-5 flex gap-2">
            <button
              onClick={onCancel}
              className="flex-1 rounded-xl border border-border px-4 py-3 font-semibold text-ink"
            >
              Back
            </button>
            <button
              onClick={complete}
              disabled={busy || remaining > 0}
              className="flex-1 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-40"
            >
              {busy ? "Completing…" : "Complete sale"}
            </button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">Cashier: {cashierName}</p>
        </section>
      </div>
    </div>
  );
}
