/**
 * Whether `value` is shaped like a uuid. Route params are user input: a
 * non-uuid id cannot name any row, and handing it to a `uuid` column makes
 * Postgres answer `invalid input syntax for type uuid` — a 500 — instead of
 * the honest "not found". Callers check this first and answer 400/404.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
