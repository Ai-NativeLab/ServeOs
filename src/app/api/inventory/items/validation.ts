/**
 * A conversion factor must be a positive number: `0` and negatives would make
 * every conversion through it nonsense, and a non-numeric value becomes the
 * literal string "NaN" in a numeric column — a driver 500 at the first
 * movement instead of a 400 here. Lives beside the routes rather than in them
 * because a route module may only export its HTTP handlers.
 */
export function invalidFactor(v: unknown): boolean {
  return v !== undefined && (!Number.isFinite(Number(v)) || Number(v) <= 0);
}
