import { useState } from "react";
import {
  EMPTY_BUYER_DRAFT,
  OPTIONAL_BUYER_FIELDS,
  REQUIRED_BUYER_FIELDS,
  buildPosSaleBuyer,
  validateBuyerDraft,
  type BuyerDraft,
  type BuyerErrors,
  type PosSaleBuyer,
} from "../fiscal/buyer";

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

/**
 * THE BUSINESS-BUYER SECTION, AND WHY IT IS COLLAPSED BY DEFAULT.
 *
 * Leaving it shut is an ORDINARY B2C SALE — the same sale this screen has always
 * rung, unchanged in every respect including the fiscal document it produces.
 * Opening it and filling it in makes the sale a B2B one, declared to ETA as a
 * tax invoice (`e_invoice`) INSTEAD of an e-receipt. That is a one-way choice at
 * the counter: ETA has no mechanism ServeOS knows of for converting a filed
 * receipt into an invoice afterwards (VERIFY-12), which is exactly why the
 * capture has to happen here rather than on the dashboard the next morning.
 *
 * VALIDATED LOCALLY, BEFORE THE SALE IS SENT. `../fiscal/buyer` mirrors the
 * server's `buyerSchema` by hand; the sale is refused at this button if the
 * section is open and incomplete, because the alternative is a permanent
 * `EtaConfigError` on a `failed` row hours later, with the customer long gone.
 */
export function PaymentScreen({
  total,
  cashierName,
  hasOpenShift,
  onNeedDrawer,
  onCancel,
  onComplete,
}: {
  total: number;
  cashierName: string;
  /** Cash needs an open drawer. The server enforces it; this is the affordance. */
  hasOpenShift: boolean;
  onNeedDrawer: () => void;
  onCancel: () => void;
  /** `buyer` is `undefined` for every ordinary sale — the business section left
   *  collapsed — and the caller's payload is unchanged in that case. */
  onComplete: (tenders: TenderDraft[], buyer?: PosSaleBuyer) => Promise<void>;
}) {
  const [tenders, setTenders] = useState<TenderDraft[]>([]);
  const [method, setMethod] = useState<TenderMethod>("cash");
  const [entry, setEntry] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [b2bOpen, setB2bOpen] = useState(false);
  const [buyer, setBuyer] = useState<BuyerDraft>(EMPTY_BUYER_DRAFT);
  // Populated only once the cashier has tried to complete: marking every box red
  // while they are still typing the first one is noise, not help.
  const [buyerErrors, setBuyerErrors] = useState<BuyerErrors>({});

  const setBuyerField = (key: keyof BuyerDraft, value: string) => {
    setBuyer((prev) => ({ ...prev, [key]: value }));
    // Clearing this field's own error as it is corrected keeps the marks honest
    // without re-running a validation the cashier has not asked for again.
    setBuyerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const remaining = splitRemaining(total, tenders);
  const paid = round2(total - remaining);
  const change = round2(tenders.reduce((s, t) => s + changeFor(t), 0));
  const entered = Number(entry || 0);

  function addTender(handedOver: number) {
    // Cash must land in an accounted drawer. The server refuses it outright;
    // stopping here means the cashier finds out before they ring the sale,
    // not after the customer has handed over notes.
    if (method === "cash" && !hasOpenShift) {
      setError("Open a drawer before taking cash");
      return;
    }
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
    // THE BUYER GATE, BEFORE ANYTHING IS SENT. A collapsed section is not a B2B
    // sale and is never validated; an OPEN one must be complete, because a tax
    // invoice has no partial form and there is no way back to a receipt once
    // this sale is filed.
    let captured: PosSaleBuyer | undefined;
    if (b2bOpen) {
      const errors = validateBuyerDraft(buyer);
      if (Object.keys(errors).length > 0) {
        setBuyerErrors(errors);
        setError("Complete the business buyer details, or close that section to ring an ordinary sale");
        return;
      }
      // Non-null by construction — `validateBuyerDraft` just passed — but read
      // back through the same builder so there is one place that shapes the
      // payload.
      captured = buildPosSaleBuyer(buyer) ?? undefined;
    }

    setBusy(true);
    setError(null);
    try {
      await onComplete(tenders, captured);
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

          {!hasOpenShift && (
            <div className="mt-4 rounded-xl border border-border bg-background p-3">
              <p className="text-sm text-muted-foreground">
                No drawer is open, so this till can only take card payments.
              </p>
              <button
                onClick={onNeedDrawer}
                className="mt-2 w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
              >
                Open drawer
              </button>
            </div>
          )}
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

          <div className="mt-5 rounded-xl border border-border">
            <button
              type="button"
              onClick={() => setB2bOpen(!b2bOpen)}
              aria-expanded={b2bOpen}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium text-ink"
            >
              <span>
                Business buyer <span dir="rtl" lang="ar">(فاتورة ضريبية)</span>
              </span>
              <span className="text-muted-foreground">{b2bOpen ? "−" : "+"}</span>
            </button>

            {b2bOpen && (
              <div className="border-t border-border px-3 py-3">
                <p className="text-xs text-muted-foreground">
                  This sale will be filed with ETA as a tax invoice instead of an e-receipt. All seven
                  fields are required and cannot be added later.
                </p>

                {/* TRN and name first and on their own: they are what the cashier
                    asks the customer for, and the address is what the customer
                    reads off a card. */}
                {REQUIRED_BUYER_FIELDS.slice(0, 2).map((field) => (
                  <div key={field.key} className="mt-2">
                    <input
                      value={buyer[field.key]}
                      onChange={(e) => setBuyerField(field.key, e.target.value)}
                      placeholder={field.label}
                      aria-label={field.label}
                      inputMode={field.key === "rin" ? "numeric" : undefined}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    />
                    {buyerErrors[field.key] && (
                      <p role="alert" className="mt-1 text-xs text-destructive">
                        {field.label}: {buyerErrors[field.key]}
                      </p>
                    )}
                  </div>
                ))}

                {/* The five mandatory address parts, grouped and labelled as one
                    thing — ETA treats the address as a unit and refuses an
                    invoice missing any part of it. */}
                <p className="mt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Registered address
                </p>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {REQUIRED_BUYER_FIELDS.slice(2).map((field) => (
                    <div key={field.key}>
                      <input
                        value={buyer[field.key]}
                        onChange={(e) => setBuyerField(field.key, e.target.value)}
                        placeholder={field.label}
                        aria-label={field.label}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                      />
                      {buyerErrors[field.key] && (
                        <p role="alert" className="mt-1 text-xs text-destructive">
                          {field.label}: {buyerErrors[field.key]}
                        </p>
                      )}
                    </div>
                  ))}
                  {OPTIONAL_BUYER_FIELDS.map((field) => (
                    <input
                      key={field.key}
                      value={buyer[field.key]}
                      onChange={(e) => setBuyerField(field.key, e.target.value)}
                      placeholder={`${field.label} (optional)`}
                      aria-label={`${field.label} (optional)`}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 flex gap-2">
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
