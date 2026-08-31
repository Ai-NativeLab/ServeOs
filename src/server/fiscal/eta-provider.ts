import type {
  FiscalProvider,
  FiscalSaleInput,
  FiscalRefundInput,
  FiscalDocument,
  FinalizedFiscalDocument,
  FiscalSubmitResult,
  EtaConfig,
} from "./provider";
import { buildReceipt, buildReturnReceipt } from "./build-document";
import { stringifyWire } from "./serialize";
import { getEtaEnv } from "./eta-env";
import { EtaTransportError, EtaConfigError, redactAuthMaterial } from "./eta-transport-errors";

/**
 * The HTTP seam. Identical to the global `fetch`, so production passes nothing
 * and tests pass a stub that returns real `Response` objects — mocking happens
 * at the wire boundary, not at some hand-rolled client interface, so the tests
 * exercise header assembly, body encoding and status handling for real.
 */
export type FetchLike = typeof fetch;

/** One cached bearer token. Lives in process memory ONLY — see the cache's
 *  JSDoc on `EtaFiscalProvider`. */
type CachedToken = { token: string; expiresAtMs: number };

/**
 * Renew this long before `expires_in` runs out.
 *
 * Authenticate POS: "Your system should be responsible to obtain a new access
 * token using this endpoint before the expiry of the current valid token to
 * continue calling the APIs." A token that expires in flight costs a 401 and a
 * re-auth round trip; against a 3600s TTL, a minute of headroom is free.
 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** `POST {identityBase}/connect/token` — Authenticate POS and Login as
 *  Taxpayer System are the same endpoint on the identity service, differing
 *  only in how the client authenticates. */
const TOKEN_PATH = "/connect/token";

/** `POST {apiBase}/api/v1/receiptsubmissions` — Submit Receipt Documents. */
const SUBMIT_PATH = "/api/v1/receiptsubmissions";

/**
 * How long any single ETA call may hang before it is abandoned as a transport
 * failure.
 *
 * Node's `fetch` has no timeout of its own: a connection that opens and then
 * goes silent hangs until the peer or the OS gives up, which can be minutes.
 * That is not a theoretical tidiness problem here — the submission worker holds
 * a claim lease while this call is in flight, and a hang that outlives the
 * lease lets a second drain claim the same row and re-POST a document ETA may
 * already hold. `ETA_HTTP_TIMEOUT_MS` is therefore part of the worker's
 * lease arithmetic; `CLAIM_LEASE_MS` in `./worker` cites it by name.
 *
 * 60s is generous for a single-document submission and still an order of
 * magnitude inside ETA's ~10-minute duplicate-submission window.
 */
export const ETA_HTTP_TIMEOUT_MS = 60_000;

/**
 * The single error status both login pages document for `/connect/token`.
 * Every documented `error` value under it names a credential, header or grant
 * that is wrong and will stay wrong, so it maps to `EtaConfigError` rather
 * than joining the retry loop — see `tokenConfigError`.
 */
const TOKEN_ERROR_STATUS = 400;

/**
 * The ETA provider.
 *
 * `build*` delegate to the pure mappers in `./build-document`; `./eta-wire` +
 * `./serialize` turn the result into receipt v1.2 JSON with its self-computed
 * uuid and QR url. `submit`/`poll` are the only methods that touch the
 * network.
 *
 * SOURCES — every request and response shape below comes from these pages, and
 * nothing is invented:
 *   Authenticate POS            https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/
 *   Login as Taxpayer System    https://sdk.invoicing.eta.gov.eg/api/01-login-as-taxpayer-system/
 *   Submit Receipt Documents    https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/
 *   Get Receipt Submission      https://sdk.invoicing.eta.gov.eg/ereceiptapi/06-get-receipt-submission/
 *   Standard Header Parameters  https://sdk.invoicing.eta.gov.eg/standard-header-parameters/
 *   Standard Error Response     https://sdk.invoicing.eta.gov.eg/standard-error-response/
 *   APIs Governance             https://sdk.invoicing.eta.gov.eg/apigovernance/
 *   Environment URLs            https://sdk.invoicing.eta.gov.eg/faq/
 * Where a page left a shape ambiguous, ETA's own published Postman collection
 * (/files/Egyptian eInvoicing SDK.postman_collection.json) is the tie-breaker,
 * cited at each site.
 *
 * TOKEN CACHE. `#tokens` is an INSTANCE field, keyed by
 * `environment|clientId|posSerial`, so one process holds at most one live token
 * per credential. `src/server/fiscal/index.ts` constructs a single shared
 * provider, which is the process-wide cache; a test that constructs its own
 * provider gets its own empty cache and needs no reset hook. Tokens are held in
 * memory only: never written to a database, never logged, never returned to a
 * caller, and gone when the process exits. Entries evict themselves as soon as
 * a lookup finds them expired, so a device that stops trading stops occupying
 * the map rather than pinning a dead token until process exit.
 *
 * OPERATIONAL NOTE — because that singleton is shared, this is a process-wide,
 * CROSS-TENANT token store. The keying is correct (environment + client id +
 * POS serial, so no tenant can ever be handed another's token), but the
 * blast radius of a memory disclosure is not one tenant: a heap dump, a core
 * file or a debugger attached to this process holds every currently-trading
 * tenant's live ETA bearer token. Treat heap dumps from a fiscal-serving
 * process as credential material.
 *
 * SINGLE FLIGHT. `#logins` holds the in-flight login promise per cache key, so
 * N concurrent submissions for one device issue ONE `/connect/token` call and
 * share its result instead of racing N logins against ETA's rate limits.
 */
export class EtaFiscalProvider implements FiscalProvider {
  readonly name = "eta";

  readonly #http: FetchLike;
  readonly #timeoutMs: number;
  readonly #tokens = new Map<string, CachedToken>();
  readonly #logins = new Map<string, Promise<string>>();

  /**
   * @param http Injectable `fetch`. The default delegates to the global one at
   * call time (rather than capturing it) so a test that stubs `globalThis.fetch`
   * still works, and so a deployment can pass a fetch bound to an undici
   * dispatcher carrying ETA's preprod root CA — see `./eta-env`'s CA-seam note.
   * @param opts.timeoutMs Per-call deadline, defaulting to
   * `ETA_HTTP_TIMEOUT_MS`. Overridable so a test can prove the deadline without
   * waiting a real minute; production has no reason to change it, and the
   * worker's lease arithmetic assumes it has not.
   */
  constructor(http?: FetchLike, opts: { timeoutMs?: number } = {}) {
    this.#http = http ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? ETA_HTTP_TIMEOUT_MS;
  }

  buildReceipt(input: FiscalSaleInput): FiscalDocument {
    return buildReceipt(input);
  }

  buildReturnReceipt(input: FiscalRefundInput): FiscalDocument {
    return buildReturnReceipt(input);
  }

  /**
   * Submits ONE finalized document and maps ETA's answer.
   *
   * Body: `{"receipts":[<document>]}` — Submit Receipt Documents marks
   * `receipts` as "List of document objects submitted. List should have at
   * least one document.", and ETA's Postman samples ("2.1. Submit Receipt",
   * "2.2. Submit Return Receipt") post exactly that single-key object. See
   * `buildSubmissionBody` for why `signatures` is absent.
   *
   * RESULT MAPPING. A 202 does not mean the document passed: "Given that the
   * process of validation is not complete when result is returned, API returns
   * HTTP status code 202", and `acceptedDocuments` is the set "accepted for
   * further processing". So a document that appears in `acceptedDocuments` maps
   * to "submitted", not "accepted" — its `uuid`/`longId` are carried through
   * because ETA assigns them at this point and they are worth persisting early,
   * but the terminal verdict only ever comes from `poll`. A document in
   * `rejectedDocuments` was judged and refused now, so it maps to the terminal
   * "rejected" with ETA's error captured in `responseJson`.
   */
  async submit(finalized: FinalizedFiscalDocument, cfg: EtaConfig): Promise<FiscalSubmitResult> {
    const url = `${getEtaEnv(cfg.environment).apiBase}${SUBMIT_PATH}`;
    const res = await this.#authedRequest(cfg, url, {
      method: "POST",
      // "The format used should be provided through Content-type request header
      // value ("application/json")" — Submit Receipt Documents.
      headers: { "Content-Type": "application/json" },
      body: buildSubmissionBody(finalized.wire),
    });

    const body = await readJsonBody(res);
    if (res.status !== 202) throw transportErrorFor(res, body, "receipt submission");

    const json = body.json;
    if (!json) {
      // See the note on the missing-submissionUUID throw below: retrying an
      // unparseable 202 can resubmit a receipt ETA already holds.
      throw new EtaTransportError("fiscal: ETA returned 202 for a receipt submission with no JSON body", {
        status: res.status,
        correlationId: correlationIdOf(res),
      });
    }

    const responseJson = redactAuthMaterial(json);
    const rejected = findByUuid(json.rejectedDocuments, finalized.uuid);
    if (rejected) {
      return { status: "rejected", etaUuid: finalized.uuid, responseJson };
    }

    const submissionUuid = typeof json.submissionUUID === "string" ? json.submissionUUID : null;
    if (!submissionUuid) {
      // Without it there is nothing to poll, so the document would be stranded
      // in "submitted" forever. Treat it as a transport failure and retry.
      //
      // KNOWN TRADE, and the reason this throw is worth reading twice: a 202
      // means ETA ACCEPTED the submission. Throwing here loses our handle on
      // something ETA is already processing, and the retry re-POSTs it. Inside
      // ETA's duplicate window that is harmless — "identical submission
      // detected based on the previous submissions sent by the same taxpayer
      // within the past 10 minutes" comes back as 422 DuplicateSubmission —
      // but a retry that lands OUTSIDE that ~10-minute window can file a
      // second copy of a receipt ETA already holds. Task 5 must therefore
      // choose its attempt cap and backoff knowing that retries of THIS
      // failure stop being idempotent after roughly ten minutes; the
      // alternative (swallowing the failure) strands the receipt permanently,
      // which is worse, so the failure is raised and the caveat documented
      // rather than silently traded away.
      throw new EtaTransportError("fiscal: ETA returned 202 for a receipt submission with no submissionUUID", {
        status: res.status,
        correlationId: correlationIdOf(res),
        body: responseJson,
      });
    }

    const accepted = findByUuid(json.acceptedDocuments, finalized.uuid);
    return {
      status: "submitted",
      submissionUuid,
      // Our own self-computed uuid is the document's identity whether or not
      // ETA echoed it back; `longId` only exists if ETA assigned one.
      etaUuid: finalized.uuid,
      ...(typeof accepted?.longId === "string" ? { etaLongId: accepted.longId } : {}),
      qrPayload: finalized.qrUrl,
      responseJson,
    };
  }

  /**
   * Polls a prior "submitted" result for its terminal verdict.
   *
   * `GET {apiBase}/api/v1/receiptsubmissions/{submissionUuid}/details` — Get
   * Receipt Submission. Its query parameters are all filters/paging over the
   * submission's receipts; none is sent, because `submit` puts exactly one
   * document in a submission (the `FiscalProvider` contract's
   * one-document-per-submission note), so the default first page always
   * contains it.
   *
   * STATUS MAPPING, from the page's own vocabulary:
   *   root `status` "InProgress"        -> "submitted" (not finished; poll again)
   *   root `status` "Valid" / "Invalid" -> terminal, and the per-receipt row
   *   decides: receipt `status` "Valid" -> "accepted" (+ `longId`), "Invalid"
   *   -> "rejected", "Cancelled" -> "accepted".
   *
   * WHY "Cancelled" MAPS TO "accepted": the enum on `eta_submissions` is
   * pending/submitted/accepted/rejected/failed and has no cancelled member. A
   * cancelled receipt is one ETA validated and later had withdrawn — it was
   * never rejected, and recording it as such would misstate the fiscal record.
   * The raw status stays visible in `responseJson`.
   *
   * An unrecognised status is NOT guessed at: it raises `EtaTransportError`, so
   * the row keeps retrying and shows up as a stuck submission, rather than
   * being silently filed under the wrong verdict.
   */
  async poll(submissionUuid: string, cfg: EtaConfig): Promise<FiscalSubmitResult> {
    const url = `${getEtaEnv(cfg.environment).apiBase}${SUBMIT_PATH}/${encodeURIComponent(submissionUuid)}/details`;
    const res = await this.#authedRequest(cfg, url, { method: "GET", headers: {} });

    const body = await readJsonBody(res);
    if (!res.ok) throw transportErrorFor(res, body, "receipt submission poll");

    const json = body.json;
    if (!json) {
      throw new EtaTransportError("fiscal: ETA returned 200 for a submission poll with no JSON body", {
        status: res.status,
        correlationId: correlationIdOf(res),
      });
    }

    const responseJson = redactAuthMaterial(json);
    const status = typeof json.status === "string" ? json.status : null;
    if (status === "InProgress") {
      return { status: "submitted", submissionUuid, responseJson };
    }
    if (status !== "Valid" && status !== "Invalid") {
      throw new EtaTransportError(
        `fiscal: ETA submission poll returned an unrecognised status ${JSON.stringify(status)} — ` +
          "Get Receipt Submission documents only InProgress, Valid and Invalid, so this is not mapped rather than guessed",
        { status: res.status, correlationId: correlationIdOf(res), body: responseJson },
      );
    }

    // One document per submission, so the first receipt is our receipt.
    const receipt = Array.isArray(json.receipts) ? asRecord(json.receipts[0]) : null;
    if (!receipt) {
      // Terminal with no receipt row: the submission itself failed or passed as
      // a whole (`submissionErrors` carries the detail). Fall back to the root
      // verdict rather than inventing a per-document one.
      return status === "Valid"
        ? { status: "accepted", submissionUuid, responseJson }
        : { status: "rejected", submissionUuid, responseJson };
    }

    const receiptStatus = typeof receipt.status === "string" ? receipt.status : null;
    if (receiptStatus === "Invalid") {
      return { status: "rejected", submissionUuid, ...uuidOf(receipt), responseJson };
    }
    if (receiptStatus === "Valid" || receiptStatus === "Cancelled") {
      return {
        status: "accepted",
        submissionUuid,
        ...uuidOf(receipt),
        ...(typeof receipt.longId === "string" ? { etaLongId: receipt.longId } : {}),
        responseJson,
      };
    }
    throw new EtaTransportError(
      `fiscal: ETA returned an unrecognised receipt status ${JSON.stringify(receiptStatus)} — ` +
        "Get Receipt Submission documents only Valid, Invalid and Cancelled, so this is not mapped rather than guessed",
      { status: res.status, correlationId: correlationIdOf(res), body: responseJson },
    );
  }

  /**
   * Makes an authenticated call, renewing the token once on a 401.
   *
   * Authenticate POS: "compliant POS systems integrating with the solution
   * should expect that some calls can start returning not authorized error
   * codes ... that mean that most likely token has expired and needs to be
   * renewed (by another login)". Standard Error Response, 401: "Used then API
   * requires token to authorize caller, but it was not provided or was
   * malformed." So exactly one forced re-login on a 401, then the answer stands
   * — a second 401 is a real authorization problem, not a stale cache.
   *
   * `Accept-Language: en` pins the language of ETA's error messages, which are
   * persisted into `responseJson` and `lastError`; Standard Header Parameters
   * says the header "May contain the preferred language for response. Supported
   * language values in eInvoicing solution are 'en' and 'ar'".
   */
  async #authedRequest(
    cfg: EtaConfig,
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Response> {
    const send = async (token: string) =>
      this.#fetch(url, {
        method: init.method,
        headers: {
          Accept: "application/json",
          "Accept-Language": "en",
          ...init.headers,
          Authorization: `Bearer ${token}`,
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      });

    const used = await this.#token(cfg);
    const res = await send(used);
    if (res.status !== 401) return res;

    // Invalidate ONLY the entry this call actually used. A blind delete would
    // race: while this request was in flight another concurrent caller may
    // already have hit its own 401, re-logged in and cached a FRESH token, and
    // dropping that would send every concurrent request back to
    // `/connect/token` in a loop. Comparing the cached token to the one that
    // was rejected means a token someone else has since replaced is left
    // alone, and this call simply picks it up.
    const key = tokenCacheKey(cfg);
    if (this.#tokens.get(key)?.token === used) this.#tokens.delete(key);

    return send(await this.#token(cfg));
  }

  /**
   * A live bearer token for `cfg` — cached when one is still comfortably
   * valid, and single-flighted when it is not.
   *
   * SINGLE FLIGHT. A till that submits a burst of queued receipts, or a worker
   * that drains several rows for one device at once, would otherwise fire one
   * `/connect/token` per submission the moment the cache is cold: N logins
   * racing each other, N-1 of them wasted, straight into ETA's throttling. The
   * first caller to miss the cache starts the login and parks its promise in
   * `#logins`; every caller arriving while it is in flight awaits that same
   * promise. The entry is removed in `finally`, so a FAILED login is not
   * cached — the next call after a failure logs in again rather than
   * replaying a rejection forever.
   */
  async #token(cfg: EtaConfig): Promise<string> {
    const key = tokenCacheKey(cfg);
    const cached = this.#tokens.get(key);
    if (cached) {
      if (cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > Date.now()) return cached.token;
      // Past its usable life: drop it here rather than leaving a dead token
      // pinned in the map (and in the heap) until the process exits.
      this.#tokens.delete(key);
    }

    const inFlight = this.#logins.get(key);
    if (inFlight) return inFlight;

    // Nothing between the miss above and this `set` awaits, so a concurrent
    // caller cannot slip past and start a second login.
    const login = this.#login(cfg, key).finally(() => this.#logins.delete(key));
    this.#logins.set(key, login);
    return login;
  }

  /**
   * One actual `/connect/token` round trip, plus caching of its result.
   *
   * Which login is used is decided by `cfg.device`, not by a flag: a device
   * credential means the receipt path, which authenticates through Authenticate
   * POS; its absence means the ERP-level credential and Login as Taxpayer
   * System. `eta_tenant_config`'s own JSDoc makes the same split ("E-receipt
   * submission does NOT use this: each POS device authenticates with its own
   * credential instead").
   *
   * Call this only through `#token`, which owns the cache and the single-flight
   * guard.
   */
  async #login(cfg: EtaConfig, key: string): Promise<string> {
    const { headers, form } = cfg.device ? posLogin(cfg.device) : erpLogin(cfg.erp);
    const res = await this.#fetch(`${getEtaEnv(cfg.environment).identityBase}${TOKEN_PATH}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        // RFC 6749's client-credentials grant, which both login pages name
        // ("solution leverages OAuth 2.0 client credentials flow"), transmits
        // its parameters form-encoded. ETA's own Postman collection confirms
        // it: both "1. Login as Taxpayer System" and "1. Authenticate POS" use
        // body mode `urlencoded`, and the former carries an explicit
        // `Content-Type: application/x-www-form-urlencoded` header.
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: form.toString(),
    });

    const body = await readJsonBody(res);
    if (res.status === TOKEN_ERROR_STATUS) throw tokenConfigError(body.json, cfg.device !== null);
    if (!res.ok) throw transportErrorFor(res, body, "token request");

    const json = body.json;
    const token = json && typeof json.access_token === "string" ? json.access_token : null;
    if (!token) {
      throw new EtaTransportError("fiscal: ETA identity service returned no access_token", {
        status: res.status,
        correlationId: correlationIdOf(res),
      });
    }

    // "expires_in | Number | The lifetime of the access token defined in
    // seconds | 3600". A response without a usable lifetime is still a usable
    // token — it just does not go in the cache, so the next call re-logs in
    // rather than holding something of unknown validity.
    const ttl = json && typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 0;
    if (ttl * 1000 > TOKEN_EXPIRY_MARGIN_MS) {
      this.#tokens.set(key, { token, expiresAtMs: Date.now() + ttl * 1000 });
    }
    return token;
  }

  /**
   * Every outbound call funnels through here so a network-level failure becomes
   * an `EtaTransportError` (retryable) instead of a raw `TypeError` that a
   * worker would have no way to classify.
   *
   * A TIMEOUT IS A TRANSPORT FAILURE, not a verdict: nothing about an abandoned
   * request says the document was judged, so it is raised as the same retryable
   * error as a reset connection. `AbortSignal.timeout` is set here rather than
   * by each caller so no call site can forget it — see `ETA_HTTP_TIMEOUT_MS`
   * for why an unbounded hang is a correctness problem and not just a slow one.
   *
   * The signal is applied over `init`, which no caller sets, so nothing is
   * silently overridden.
   */
  async #fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#http(url, { ...init, signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (cause) {
      // `AbortSignal.timeout` rejects with a TimeoutError DOMException; an
      // AbortError would mean someone else cancelled us. Both are "no answer
      // arrived", and both are worth telling apart from a refused connection in
      // the message that lands in `eta_submissions.lastError`.
      const aborted = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
      throw new EtaTransportError(
        aborted
          ? `fiscal: ETA request timed out after ${this.#timeoutMs}ms with no response (${hostOf(url)})`
          : `fiscal: ETA request failed before a response was received (${hostOf(url)})`,
        { cause },
      );
    }
  }
}

/**
 * The Authenticate POS login: four POS headers plus the credentials in the
 * form body.
 *
 * HEADERS. Two legs of evidence, both from the page itself:
 *   1. Its header table lists exactly `posserial`, `pososversion`,
 *      `posmodelframework` and `presharedkey` (lower-case, as transcribed
 *      here) as the headers of this call. The table has NO "required" column,
 *      so requiredness is nowhere stated either way.
 *   2. Its error table defines a dedicated rejection for every one of them —
 *      `invalid_posserial`, `invalid_pososversion`, `invalid_posmodelframework`,
 *      `invalid_presharedkey` — which is only meaningful for a header ETA
 *      reads and validates.
 * (ETA's Postman "1. Authenticate POS" request is NOT cited as a third leg:
 * it carries `posmodelframework` with `"disabled": true`, so it demonstrates a
 * call that sends only three of the four. That is evidence about their sample,
 * not about what the API requires, and it is left out rather than leaned on.)
 *
 * SO A MISSING ONE FAILS FAST, IT IS NOT OMITTED. `presharedKey`, `osVersion`
 * and `modelFramework` are all nullable on `eta_pos_credentials` (the portal's
 * pre-shared-key provisioning flow is undocumented — see that column's JSDoc).
 * Sending the request without them would buy an `invalid_presharedkey` from
 * ETA, which arrives as an HTTP 400 and would be indistinguishable from a
 * wrong key; the real fault is that the device was never fully provisioned.
 * Raising `EtaConfigError` here names the missing column, skips a pointless
 * round trip, and — because `EtaConfigError` is not retryable — keeps a
 * provisioning gap out of the backoff loop where it would hide for hours.
 *
 * BODY. `grant_type` / `client_id` / `client_secret`, exactly the page's three
 * body parameters. No `scope`: the POS page's body table does not list one
 * (unlike the ERP page's), and neither does ETA's Postman POS request.
 *
 * WHICH SECRET. ETA issues each device a Secret 1 and a Secret 2, but the API
 * takes a single `client_secret`. `secret1` is used; `secret2` is the rotation
 * spare, and rotating between them is a deliberate future flow, not a silent
 * fallback here — trying the other secret after a rejection would turn one
 * clear `invalid_clientsecret` into two.
 */
function posLogin(device: NonNullable<EtaConfig["device"]>): { headers: Record<string, string>; form: URLSearchParams } {
  const missing = (column: string, code: string): never => {
    throw new EtaConfigError(
      code,
      `fiscal: this POS device has no ${column}, which Authenticate POS sends as a validated header ` +
        "(ETA defines a dedicated rejection code for it). Finish provisioning the device before submitting receipts.",
    );
  };

  const presharedKey = device.presharedKey ?? missing("preshared_key_ref", "device-preshared-key-missing");
  const osVersion = device.osVersion ?? missing("pos_os_version", "device-os-version-missing");
  const modelFramework = device.modelFramework ?? missing("pos_model_framework", "device-model-framework-missing");

  return {
    headers: {
      posserial: device.serial,
      pososversion: osVersion,
      posmodelframework: modelFramework,
      presharedkey: presharedKey,
    },
    form: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: device.clientId,
      client_secret: device.secret1,
    }),
  };
}

/**
 * The Login as Taxpayer System (ERP) login: HTTP Basic, with only `grant_type`
 * and `scope` in the body.
 *
 * The page's header table defines `Authorization` as "Must contain basic
 * authorization string created using issued Client ID and Client Secret for the
 * ERP system. The process of creating basic authorization string should follow
 * RFC 2617", and its body table lists exactly two parameters: `grant_type` and
 * `scope`.
 *
 * `scope` IS SENT ON EVERY CALL, even though the page marks it OPTIONAL
 * ("Optional parameter asking for a specific access scope. In case of external
 * access to eInvoicing APIs this parameter can be omitted", example value
 * `InvoicingAPI`). Sending it matches ETA's own Postman "1. Login as Taxpayer
 * System", which always includes `scope=InvoicingAPI`, and it makes the granted
 * scope explicit rather than dependent on a server-side default: the token
 * response's `scope` is documented as "Optional if matches the requested scope.
 * Otherwise contains information on scope granted to token", so asking for one
 * turns a silent narrowing into a visible mismatch.
 *
 * KNOWN DIVERGENCE: ETA's Postman "1. Login as Taxpayer System" instead sends
 * `client_id`/`client_secret` in the form body with no Basic header. RFC 6749
 * section 2.3.1 permits both, but says a client MUST NOT use more than one
 * method per request, so the two cannot be combined. The documentation page
 * wins here because it is the normative contract; if an ERP credential is ever
 * rejected in preprod with `invalid_client`, moving the credentials into the
 * body is the first thing to try.
 *
 * UNEXERCISED TODAY: the receipt path always has a device credential, and B2B
 * `e_invoice` is deferred, so nothing currently reaches this branch.
 */
function erpLogin(erp: EtaConfig["erp"]): { headers: Record<string, string>; form: URLSearchParams } {
  // Calling the thunk is what resolves the secret — and what can throw
  // EtaConfigError if its env ref is stale. That is deliberate: this is the
  // only path that needs it, so the failure lands here rather than taking the
  // receipt path down with it.
  const basic = Buffer.from(`${erp.clientId}:${erp.clientSecret()}`, "utf8").toString("base64");
  return {
    headers: { Authorization: `Basic ${basic}` },
    form: new URLSearchParams({ grant_type: "client_credentials", scope: "InvoicingAPI" }),
  };
}

/**
 * The request body for one document.
 *
 * `stringifyWire`, not `JSON.stringify`: ETA re-derives the uuid from the
 * document it receives, and `JSON.stringify` would turn the wire layer's
 * `WireDecimal` values into objects, so the transmitted bytes would no longer
 * carry the literals that were hashed. The envelope is assembled around that
 * string by hand for the same reason.
 *
 * `signatures` IS DELIBERATELY ABSENT, and this is the one place where the
 * documentation is genuinely two-sided. Submit Receipt Documents lists it as an
 * input — "Structure containing one or two digital signatures. At least
 * signature of the Issuer must be present. Signature of the Service provider is
 * optional." — where a signature `value` is a "CAdES-BES standard Base64
 * encoded signature". The same page then says: "Note! The function to perform
 * signature validation will not be deployed at this point until a decision is
 * provided by ETA to test and deploy the component." And every receipt
 * submission in ETA's own Postman collection posts `{"receipts":[...]}` with no
 * `signatures` key at all.
 *
 * ServeOS has no receipt e-seal to sign with (`EtaConfig.signingKey` is B2B
 * material and is null for receipt-only tenants — see its JSDoc, and the plan's
 * open VERIFY 2 on whether B2C e-receipts need one), so the only alternatives
 * were to omit the element or to fabricate a value. Omitting it matches ETA's
 * working samples and asserts nothing untrue; the `signatures` parameter below
 * is the seam for the day a signer exists.
 */
export function buildSubmissionBody(
  wire: Record<string, unknown>,
  signatures?: { signatureType: string; value: string }[],
): string {
  const receipts = `"receipts":[${stringifyWire(wire)}]`;
  if (!signatures || signatures.length === 0) return `{${receipts}}`;
  return `{${receipts},"signatures":${JSON.stringify(signatures)}}`;
}

/** Cache key: one token per credential per environment. The POS serial is part
 *  of it because ETA issues a token against the device identity, so two devices
 *  sharing a client id must not share a token. No secret is in the key. */
function tokenCacheKey(cfg: EtaConfig): string {
  return cfg.device
    ? `${cfg.environment}|${cfg.device.clientId}|${cfg.device.serial}`
    : `${cfg.environment}|${cfg.erp.clientId}|erp`;
}

/**
 * An HTTP 400 from `/connect/token`, turned into the permanent config failure
 * it is.
 *
 * Both login pages document 400 as the single error status, with an `error`
 * string naming the fault. Every documented value — `invalid_posserial`,
 * `invalid_presharedkey`, `invalid_clientsecret`, `invalid_client`,
 * `unauthorized_client` ("System authentication can be rejected if invalid
 * client ID and secret is used to authenticate or the system user registered
 * against the taxpayer is blocked or expired"), `unsupported_grant_type`,
 * `invalid_scope`, `invalid_request`, `invalid_grant` — describes a credential,
 * a header or a grant that is wrong and will stay wrong. ETA's own code is kept
 * verbatim as the `EtaConfigError` code so it can be looked up in the SDK.
 *
 * `error_description` ("Optional human readable error message containing more
 * details about error encountered", e.g. "User blocked") is included when
 * present; it describes the account, never the credential.
 */
function tokenConfigError(json: Record<string, unknown> | null, isPos: boolean): EtaConfigError {
  const code = json && typeof json.error === "string" ? json.error : "invalid_request";
  const description = json && typeof json.error_description === "string" ? `: ${json.error_description}` : "";
  const which = isPos ? "Authenticate POS" : "Login as Taxpayer System";
  return new EtaConfigError(
    code,
    `fiscal: ETA rejected the ${which} credentials with ${code}${description}. ` +
      "This needs a configuration fix — it will not resolve on retry.",
  );
}

/** The parsed response body, or a note that it was not JSON. */
type ReadBody = { json: Record<string, unknown> | null; contentType: string | null };

/**
 * Reads a response body as JSON when it says it is JSON.
 *
 * A non-JSON body (an HTML error page from a proxy, an empty 503) is
 * deliberately NOT captured as text: this value is persisted into
 * `eta_submissions.responseJson` and error rows, and free text cannot be
 * redacted reliably. `correlationId` is the documented handle for chasing such
 * a response with ETA support, and it is captured instead.
 */
async function readJsonBody(res: Response): Promise<ReadBody> {
  const contentType = res.headers.get("content-type");
  if (!contentType || !contentType.toLowerCase().includes("json")) {
    return { json: null, contentType };
  }
  try {
    const parsed: unknown = await res.json();
    return { json: asRecord(parsed), contentType };
  } catch {
    return { json: null, contentType };
  }
}

/**
 * Any non-success HTTP status, turned into a retryable `EtaTransportError`
 * carrying everything a worker or an operator needs and nothing they must not
 * have.
 *
 * The message names the status, ETA's error code and the correlation id. The
 * body is included only when it parsed as JSON, and only after
 * `redactAuthMaterial`. Request headers are never touched here — the
 * Authorization header exists only inside the `fetch` init and is never read
 * back — so no bearer token, client secret or pre-shared key can reach the
 * persisted value.
 *
 * See `EtaTransportError`'s JSDoc for the documented ambiguity around 400
 * `BadStructure` / `MaximumSizeExceeded` and 403 `IncorrectSubmitter`, which
 * are probably permanent but which the pages never describe as a per-document
 * rejection.
 */
function transportErrorFor(res: Response, body: ReadBody, what: string): EtaTransportError {
  const redacted = body.json ? redactAuthMaterial(body.json) : null;
  const etaErrorCode = errorCodeOf(redacted);
  const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
  const detail = [
    etaErrorCode ? `code ${etaErrorCode}` : null,
    retryAfterSeconds === null ? null : `retry after ${retryAfterSeconds}s`,
    body.json ? null : `non-JSON body (${body.contentType ?? "no content-type"})`,
  ]
    .filter(Boolean)
    .join(", ");

  return new EtaTransportError(`fiscal: ETA ${what} failed with HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, {
    status: res.status,
    retryAfterSeconds,
    etaErrorCode,
    correlationId: correlationIdOf(res),
    body: redacted,
  });
}

/**
 * ETA's error code out of either documented error envelope.
 *
 * Standard Error Response nests it: `{"error": {"code": "BadStructure",
 * "message": ...}}`. APIs Governance publishes a FLAT variant for throttling
 * whose code is a NUMBER, not a string — `{"error": "Too many requests",
 * "message": "...", "code": 429}` for 429, and the same shape with `"code":
 * 503`. A string-only read silently dropped those, losing the one
 * machine-readable discriminator on exactly the two statuses a worker most
 * needs to tell apart, so numbers are accepted and normalised to their decimal
 * string ("429"). A nested string code still wins when both are present, since
 * `BadStructure` says more than `400`.
 */
function errorCodeOf(json: Record<string, unknown> | null): string | null {
  if (!json) return null;
  const error = asRecord(json.error);
  if (error) {
    const nested = codeToString(error.code);
    if (nested !== null) return nested;
  }
  return codeToString(json.code);
}

/** A `code` field as a string, whether ETA sent it as one or as a number. */
function codeToString(code: unknown): string | null {
  if (typeof code === "string") return code;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  return null;
}

/**
 * `Retry-After`, in whole seconds.
 *
 * Standard Error Response, 429: the header "contains a number, indicating the
 * seconds remaining for this client to try again", and Submit Receipt
 * Documents says the same for 422 `DuplicateSubmission` ("based on the returned
 * value in the response header Retry-After in seconds"). The HTTP-date form is
 * also legal per RFC 7231 and is accepted as a fallback rather than dropped;
 * anything else yields null, and the caller falls back to its own backoff.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/** "correlationId | Defines the unique string value that can be used to track
 *  the calls in the system" — Standard Header Parameters. Not sensitive; it is
 *  what ETA support asks for. */
function correlationIdOf(res: Response): string | null {
  return res.headers.get("correlationid");
}

/** The accepted/rejected entry for our own document, matched on the uuid we
 *  computed and transmitted. Both arrays key on `uuid` ("Unique document ID,
 *  SHA256 format"). */
function findByUuid(list: unknown, uuid: string): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const record = asRecord(entry);
    if (record && record.uuid === uuid) return record;
  }
  return null;
}

/** `etaUuid` from a polled receipt row, when it carried one. */
function uuidOf(receipt: Record<string, unknown>): { etaUuid?: string } {
  return typeof receipt.uuid === "string" ? { etaUuid: receipt.uuid } : {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Host only — a full url in a persisted error message is noise, and query
 *  strings are a place secrets end up by accident. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}
