import { sumDenominations, formatAmount } from "./counting";

/** Notes and coins in circulation, largest first — the order a drawer is counted in. */
const DENOMINATIONS = ["200", "100", "50", "20", "10", "5", "1", "0.5", "0.25"];

/**
 * Optional aid for counting a drawer. It never replaces the typed total: the
 * cashier states what they counted and this shows whether the notes agree, which
 * is the same check the server makes before it will accept the count.
 */
export function DenominationPad({
  value,
  onChange,
}: {
  value: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}) {
  const total = sumDenominations(value);

  return (
    <div className="mt-4 rounded-xl border border-border bg-background p-3">
      <div className="grid grid-cols-3 gap-2">
        {DENOMINATIONS.map((denom) => (
          <label key={denom} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-right text-sm text-muted-foreground">{denom}</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              value={value[denom] ?? ""}
              onChange={(e) => {
                const next = { ...value };
                const qty = Number(e.target.value);
                if (!e.target.value.trim() || !Number.isFinite(qty) || qty <= 0) delete next[denom];
                else next[denom] = qty;
                onChange(next);
              }}
              className="w-full rounded-lg border border-border bg-card px-2 py-2 text-base"
              aria-label={`Count of ${denom}`}
            />
          </label>
        ))}
      </div>
      <p className="mt-3 text-right text-sm text-muted-foreground">
        Pad total <span className="font-semibold text-ink">{formatAmount(total)}</span>
      </p>
    </div>
  );
}
