/**
 * The two failure families that live OUTSIDE `FiscalDocumentError`.
 *
 * `./errors.ts` holds document-construction failures, which are all PERMANENT:
 * the inputs can never produce a valid ETA document. The two errors here are
 * different in kind, and deliberately do not extend `FiscalDocumentError` so
 * that Task 5's worker cannot accidentally treat them the same way:
 *
 *   EtaTransportError  RETRYABLE.  The call did not land. Worker: attempts++,
 *                      backoff, try again (respecting `retryAfterSeconds`).
 *   EtaConfigError     PERMANENT, but a CONFIGURATION fault, not a document
 *                      fault. Worker: fail the row without backoff and alert
 *                      the owner — retrying cannot invent a missing secret.
 *
 * Neither ever carries a secret. Messages name the *reference* (an env key, a
 * column) or an HTTP status, never a token, a client secret or a pre-shared
 * key, because these strings reach `eta_submissions.lastError` and the logs.
 */

/**
 * A call to ETA that did not produce a usable answer: throttled (429), refused
 * by the gateway (5xx), a malformed body where a documented shape was
 * promised, or the network failing outright.
 *
 * RETRYABLE BY DEFINITION. Task 5's worker maps this to `attempts++` plus a
 * backoff — never to a terminal `rejected`, because nothing here says the
 * document was judged and refused. A document ETA actually looked at and
 * refused arrives as `FiscalSubmitResult.status === "rejected"`, not as a
 * throw.
 *
 * AMBIGUITY, DOCUMENTED. The Submit Receipt Documents page defines three
 * non-202 outcomes that are arguably permanent rather than transient:
 *   - 400 `BadStructure` — "Returned when there is a structural error with the
 *     submission message."
 *   - 400 `MaximumSizeExceeded` — "Returned when the size of the submission
 *     exceeds allowed limit."
 *   - 403 `IncorrectSubmitter` — "Returned when submitted of the documents is
 *     trying to submit them on behalf of the other taxpayer."
 * Retrying any of those unchanged will fail identically every time. They are
 * still raised as `EtaTransportError` rather than mapped to `"rejected"`,
 * because the page reserves per-document rejection for the 202 body's
 * `rejectedDocuments` array — none of these codes says "this receipt was
 * judged invalid". `etaErrorCode` is carried so the worker (or a later task)
 * can special-case them into a no-retry terminal failure once ETA's behaviour
 * is observed in preprod; until then the backoff cap is what stops them.
 *
 * 422 `DuplicateSubmission` genuinely is transient — "identical submission
 * detected ... within the past 10 minutes ... Issuer can try submitting the
 * same payload again based on the returned value in the response header
 * Retry-After in seconds" — and lands here with `retryAfterSeconds` set.
 */
export class EtaTransportError extends Error {
  /** HTTP status, or null when the request never got a response (DNS, TLS,
   *  connection reset, abort). */
  readonly status: number | null;
  /**
   * Whole seconds from the `Retry-After` response header, when ETA sent one.
   *
   * Standard Error Response, 429: "Retry-After response header in case of this
   * error response contains a number, indicating the seconds remaining for
   * this client to try again." APIs Governance adds that the wait "should be
   * larger then the value returned in the response in the header Retry-After",
   * so a worker should treat this as a FLOOR, not the exact next attempt time.
   */
  readonly retryAfterSeconds: number | null;
  /** ETA's own error code from the response body's `error.code` (BadStructure,
   *  MaximumSizeExceeded, IncorrectSubmitter, DuplicateSubmission,
   *  TooManyRequests, ...), when the body carried the standard error shape. */
  readonly etaErrorCode: string | null;
  /**
   * The `correlationId` response header — "the unique string value that can be
   * used to track the calls in the system that were made during a single
   * session", and the handle ETA support asks for. Not sensitive.
   */
  readonly correlationId: string | null;
  /** The response body, JSON-parsed and passed through `redactAuthMaterial`.
   *  Null when the body was absent or not JSON — a non-JSON body is described
   *  in `message` rather than captured, because free text cannot be redacted
   *  reliably and this value is persisted. */
  readonly body: Record<string, unknown> | null;

  constructor(
    message: string,
    opts: {
      status?: number | null;
      retryAfterSeconds?: number | null;
      etaErrorCode?: string | null;
      correlationId?: string | null;
      body?: Record<string, unknown> | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "EtaTransportError";
    this.status = opts.status ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
    this.etaErrorCode = opts.etaErrorCode ?? null;
    this.correlationId = opts.correlationId ?? null;
    this.body = opts.body ?? null;
  }
}

/**
 * The tenant's or device's ETA credentials cannot be assembled, or ETA refused
 * them as wrong.
 *
 * PERMANENT until a human changes configuration, so a worker must NOT put this
 * on the backoff clock: no number of retries will populate an unset env var,
 * provision a missing pre-shared key, or un-block a blocked ETA system user.
 * It is nonetheless not a `FiscalDocumentError` — the document is fine; the
 * account is not — so the two stay distinguishable in `lastError` and in the
 * owner-facing alert, which want different wording ("configure ETA" vs "fix
 * this product's tax code").
 *
 * `code` is the stable machine-readable discriminator. Locally-raised codes
 * are kebab-case (`missing-secret-ref`, `device-preshared-key-missing`); a
 * code echoed from ETA's token endpoint keeps ETA's own spelling
 * (`invalid_presharedkey`, `invalid_clientsecret`, `unauthorized_client`, ...)
 * so it can be looked up in the SDK without translation.
 */
export class EtaConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EtaConfigError";
  }
}

/**
 * Keys that must never survive into `eta_submissions.responseJson` or into an
 * error we persist. None of them appears in any documented ETA response body —
 * this is a belt-and-braces net for an undocumented field or a proxy that
 * echoes the request, not a substitute for simply never putting request
 * headers in here (which the provider does not).
 */
const REDACTED_KEYS = new Set([
  "authorization",
  "presharedkey",
  "preshared_key",
  "client_secret",
  "clientsecret",
  "client_secret_1",
  "client_secret_2",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "password",
  "secret",
]);

export const REDACTED = "[redacted]";

/**
 * Deep copy of an ETA response body with any auth-shaped key replaced by
 * `[redacted]`. Matching is case-insensitive on the key name only; values are
 * never inspected, so a legitimate field is never mangled by a coincidental
 * substring.
 *
 * Arrays and nested objects are walked. Anything that is not a plain object or
 * array is returned as-is.
 */
export function redactAuthMaterial<T>(value: T): T {
  if (Array.isArray(value)) return value.map((el) => redactAuthMaterial(el)) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : redactAuthMaterial(child);
  }
  return out as unknown as T;
}
