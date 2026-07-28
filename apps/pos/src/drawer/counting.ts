/**
 * The only arithmetic the till does about a drawer.
 *
 * Expected cash, variance and every reported total come from the server — one
 * formula, server-side, is a rule of Spec 2. What belongs here is the small
 * amount of maths a cashier's own input needs before it is submitted: adding up
 * the notes and coins they just counted, and reading back what they typed.
 */

/** Cents-accurate rounding, so a denomination pad never drifts. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Σ denomination · quantity. Blank or zero rows simply contribute nothing. */
export function sumDenominations(denominations: Record<string, number>): number {
  let total = 0;
  for (const [denom, qty] of Object.entries(denominations)) {
    const d = Number(denom);
    const q = Number(qty);
    if (!Number.isFinite(d) || !Number.isFinite(q)) continue;
    total += d * q;
  }
  return round2(total);
}

/** Drops the empty rows so a count is stored as what was actually counted. */
export function compactDenominations(denominations: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [denom, qty] of Object.entries(denominations)) {
    if (Number.isFinite(Number(qty)) && Number(qty) > 0) out[denom] = Number(qty);
  }
  return out;
}

/** Parses a typed amount. Returns null for anything that is not a usable number. */
export function parseAmount(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return round2(n);
}

/**
 * Whether a denomination breakdown may accompany a typed total. The server
 * rejects a mismatch with CashCountMismatchError; catching it here means the
 * cashier is told before they submit, not after.
 */
export function denominationsAgree(denominations: Record<string, number>, countedTotal: number): boolean {
  return sumDenominations(denominations) === round2(countedTotal);
}

/** How a variance should read on a receipt: over, short, or balanced. */
export function varianceLabel(variance: number): "over" | "short" | "balanced" {
  const v = round2(variance);
  if (v > 0) return "over";
  if (v < 0) return "short";
  return "balanced";
}

/** Formats an amount for display. The POS shows plain 2dp amounts throughout. */
export function formatAmount(n: number): string {
  return n.toFixed(2);
}
