export type Locale = "en" | "ar";

export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract messageFor(locale: Locale): string;
}

/**
 * A non-finite number reached a formatter that writes to a Postgres `numeric`
 * column. Lives here rather than in a domain's errors because both formatters
 * that can raise it — `money()` in ordering and `unitRate()` in purchasing —
 * are imported across domain boundaries, and neither should depend on the
 * other's error module.
 *
 * This is an INVARIANT VIOLATION, not user input: every caller is expected to
 * have validated its numbers already, and the per-caller guards that do so stay
 * in place for their better messages. This is the backstop that makes the
 * absence of one non-silent. `NaN` and `Infinity` are accepted by Postgres
 * `numeric`, so without it a slip writes permanent, un-arithmetic-able poison
 * into a money column instead of failing.
 */
export class NonFiniteAmountError extends DomainError {
  readonly code = "non_finite_amount";
  constructor(public readonly field: string, public readonly value: number) {
    super(`${field} must be a finite number, got ${value}`);
    this.name = "NonFiniteAmountError";
  }
  messageFor(locale: Locale): string {
    return locale === "ar"
      ? "حدث خطأ في حساب أحد المبالغ، يرجى المحاولة مرة أخرى"
      : "Something went wrong calculating an amount — please try again";
  }
}

/**
 * The floor every numeric formatter shares. `field` names the formatter rather
 * than the caller's column, because the caller is expected to have raised a
 * better-worded error already — reaching here means one did not.
 */
export function assertFinite(n: number, field: string): void {
  if (!Number.isFinite(n)) throw new NonFiniteAmountError(field, n);
}
