/**
 * Exact decimal arithmetic on `money(n)` strings, for the fiscal mappers only.
 *
 * Fiscal documents are hashed: a receipt's uuid is the SHA-256 of its own
 * serialized text (see ./serialize), and ETA re-derives that hash from the
 * bytes we transmit. So a money value must survive as the *same characters*
 * end to end — `Number("115.00")` would silently become `115`, and any float
 * addition could surface `45.000000000000004`. Everything here therefore works
 * on scaled `bigint`s and returns a string.
 *
 * This is deliberately not a general decimal library: it does exactly what the
 * ETA wire mapping needs (F9 — no new money arithmetic beyond the sums ETA's
 * own document schema requires).
 */

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** `0n` written the long way: the project targets ES2017, where BigInt
 *  literals are not available. */
const ZERO = BigInt(0);

/** Throws unless `value` is a plain decimal numeral — no exponents, no NaN. */
export function assertDecimal(value: string, field: string): string {
  if (!DECIMAL.test(value)) {
    throw new Error(`fiscal: ${field} is not a decimal numeral: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Digits after the decimal point. */
function scaleOf(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

/** `value` as an integer scaled by 10^scale (scale >= scaleOf(value)). */
function toScaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).replace(".", "");
  const padded = digits + "0".repeat(scale - scaleOf(value));
  const magnitude = BigInt(padded);
  return negative ? -magnitude : magnitude;
}

/** Inverse of `toScaled`, keeping exactly `scale` decimal places. */
function fromScaled(scaled: bigint, scale: number): string {
  const negative = scaled < ZERO;
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * Exact sum, kept at the widest scale of its inputs so `money(n)`'s two
 * decimal places survive: `addDecimal("20.00", "25.00")` is `"45.00"`, never
 * `"45"` and never `45.000000000000004`.
 */
export function addDecimal(field: string, ...values: string[]): string {
  if (values.length === 0) return "0.00";
  values.forEach((v) => assertDecimal(v, field));
  const scale = Math.max(...values.map(scaleOf));
  const total = values.reduce((sum, v) => sum + toScaled(v, scale), ZERO);
  return fromScaled(total, scale);
}

/** True for "0", "0.00", "-0.000" — any spelling of zero. */
export function isZeroDecimal(value: string): boolean {
  return DECIMAL.test(value) && toScaled(value, scaleOf(value)) === ZERO;
}
