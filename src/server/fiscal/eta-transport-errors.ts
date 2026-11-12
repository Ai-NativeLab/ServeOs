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
 * The authoritative version of that mapping — all three families, with the
 * exact worker behaviour each requires — is the FAILURE TAXONOMY table on
 * `FiscalProvider` in `./provider`. The summary above is a convenience; that
 * table is the contract.
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
  /**
   * OUR code, so that all three failure families expose the same `code`
   * discriminator and a worker can log or branch on it uniformly. There is one
   * value because the family has one meaning: retry this. ETA's OWN code —
   * `BadStructure`, `DuplicateSubmission`, `429`, ... — lives in
   * `etaErrorCode`, which is the field to switch on for per-code handling.
   */
  readonly code = "eta-transport";
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
 * The shapes a secret-bearing key name takes, matched as a SUBSTRING at every
 * depth and case-insensitively.
 *
 * Substring, not exact match, deliberately. An exact-match allowlist has to
 * enumerate every spelling an upstream might use, and it will always be
 * incomplete: `posPresharedKey`, `client-secret`, `X-Api-Key`, `apiKey`,
 * `signingKey` and `clientSecret1` all name credentials and all slip past a
 * fixed list of the obvious spellings. Since `responseJson` is PERSISTED to
 * `eta_submissions`, a miss here is a durable leak, not a transient one — so
 * the net is drawn wide and the cost of a false positive (one over-redacted
 * field in a stored response body) is accepted without hesitation.
 *
 * Only KEY NAMES are tested; values are never inspected, so a legitimate value
 * is never mangled by a coincidental substring.
 *
 * `token` covers access_token/refresh_token/id_token/tokenRef; `secret` covers
 * client_secret/clientSecret1/clientSecret2/secretRef; `apikey` covers
 * apiKey/X-Api-Key/api_key once separators are stripped. Nothing on this list
 * appears in any documented ETA response body — this is the belt-and-braces
 * net for an undocumented field or a proxy that echoes the request back, not a
 * substitute for simply never putting request headers in here (which the
 * provider does not).
 */
const SECRET_KEY_PATTERN = /secret|token|password|presharedkey|authorization|apikey|signingkey/i;

export const REDACTED = "[redacted]";

/**
 * Whether a key name looks like it carries credential material.
 *
 * Separators are stripped before matching so that `X-Api-Key`, `api_key`,
 * `api key` and `apiKey` all reduce to `apikey`, and `pre-shared-key` /
 * `preshared_key` / `posPresharedKey` all contain `presharedkey`. The regex is
 * applied to BOTH the raw key and the stripped key, so a name that only
 * matches in one form is still caught.
 */
function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || SECRET_KEY_PATTERN.test(key.replace(/[-_\s.]/g, ""));
}

/**
 * Deep copy of an ETA response body with every credential-shaped key replaced
 * by `[redacted]`.
 *
 * Arrays and nested objects are walked to any depth. Anything that is not a
 * plain object or array is returned as-is.
 */
export function redactAuthMaterial<T>(value: T): T {
  if (Array.isArray(value)) return value.map((el) => redactAuthMaterial(el)) as unknown as T;
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKey(key) ? REDACTED : redactAuthMaterial(child);
  }
  return out as unknown as T;
}
