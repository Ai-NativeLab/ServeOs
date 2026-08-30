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

/** Exact difference, at the widest scale of its inputs. */
export function subtractDecimal(field: string, a: string, b: string): string {
  assertDecimal(a, field);
  assertDecimal(b, field);
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return fromScaled(toScaled(a, scale) - toScaled(b, scale), scale);
}

/** -1 / 0 / 1, comparing exactly rather than through Number(). */
export function compareDecimal(a: string, b: string): number {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  const left = toScaled(a, scale);
  const right = toScaled(b, scale);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** `a / b` at exactly `scale` decimal places, half-up. Only used where ETA's
 *  own equation forces a division (a VAT-inclusive unit price) — never on a
 *  total. */
export function divideDecimal(field: string, a: string, b: string, scale: number): string {
  assertDecimal(a, field);
  assertDecimal(b, field);
  const divisorScale = scaleOf(b);
  const divisor = toScaled(b, divisorScale);
  if (divisor === ZERO) throw new Error(`fiscal: ${field} divided by zero`);
  // Scaling the numerator by 10^(scale + divisorScale) makes the integer
  // quotient land exactly `scale` places; the doubled remainder rounds half-up.
  const numerator = toScaled(a, scale + divisorScale);
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const rounded = remainder * BigInt(2) >= divisor ? quotient + BigInt(1) : quotient;
  return fromScaled(rounded, scale);
}

/**
 * Splits `total` across `weights` proportionally, by the largest-remainder
 * method, so the parts sum to `total` EXACTLY — no rounding drift, no float.
 *
 * Each part is `floor(total * weight_i / Σweights)`; the cents left over by
 * flooring go to the largest remainders, ties broken by lowest index so the
 * split is deterministic (the same sale must always hash to the same uuid).
 */
export function allocateLargestRemainder(field: string, total: string, weights: string[]): string[] {
  assertDecimal(total, field);
  weights.forEach((w) => assertDecimal(w, `${field} weight`));
  if (weights.length === 0) return [];

  const scale = scaleOf(total);
  const weightScale = Math.max(0, ...weights.map(scaleOf));
  const scaledWeights = weights.map((w) => toScaled(w, weightScale));
  const weightSum = scaledWeights.reduce((sum, w) => sum + w, ZERO);
  const scaledTotal = toScaled(total, scale);

  if (weightSum === ZERO) {
    if (scaledTotal !== ZERO) {
      throw new Error(`fiscal: cannot allocate ${field} of ${total} — every weight is zero`);
    }
    return weights.map(() => fromScaled(ZERO, scale));
  }

  const floors = scaledWeights.map((w) => (scaledTotal * w) / weightSum);
  const remainders = scaledWeights.map((w, i) => (scaledTotal * w) - (floors[i] * weightSum));
  const distributed = floors.reduce((sum, f) => sum + f, ZERO);

  // Hand out the leftover units to the biggest remainders first.
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));

  const parts = [...floors];
  let leftover = scaledTotal - distributed;
  for (const { index } of order) {
    if (leftover === ZERO) break;
    const step = leftover > ZERO ? BigInt(1) : BigInt(-1);
    parts[index] += step;
    leftover -= step;
  }

  return parts.map((part) => fromScaled(part, scale));
}
