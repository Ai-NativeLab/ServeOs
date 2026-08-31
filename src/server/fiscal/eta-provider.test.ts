import { describe, it, expect, afterEach, vi } from "vitest";
import { EtaFiscalProvider, buildSubmissionBody, type FetchLike } from "./eta-provider";
import { EtaTransportError, EtaConfigError, REDACTED } from "./eta-transport-errors";
import { getEtaEnv } from "./eta-env";
import { finalizeReceipt, type WireContext } from "./eta-wire";
import { stringifyWire } from "./serialize";
import type { FiscalDocument, EtaConfig } from "./provider";

/**
 * Every test here mocks at the `fetch` boundary — the provider is constructed
 * with a stub that returns real `Response` objects — so header assembly, body
 * encoding and status handling are exercised for real rather than stubbed out
 * behind a hand-rolled client interface.
 *
 * The secrets below are deliberately distinctive strings so that
 * `expectNoAuthMaterial` can prove they never reach a persisted value.
 */
const PRESHARED_KEY = "PSK-c68fec13-must-never-be-persisted";
const DEVICE_SECRET_1 = "SECRET1-must-never-be-persisted";
const DEVICE_SECRET_2 = "SECRET2-never-sent-today";
const ERP_SECRET = "ERPSECRET-must-never-be-persisted";
const ACCESS_TOKEN = "TOKEN-eyJhbGciOi-must-never-be-persisted";

const PREPROD = getEtaEnv("preprod");
const TOKEN_URL = `${PREPROD.identityBase}/connect/token`;
const SUBMIT_URL = `${PREPROD.apiBase}/api/v1/receiptsubmissions`;

const cfg: EtaConfig = {
  rin: "200173707",
  environment: "preprod",
  erp: { clientId: "erp-client-id", clientSecret: () => ERP_SECRET },
  device: {
    serial: "POS-001",
    clientId: "device-client-id",
    secret1: DEVICE_SECRET_1,
    secret2: DEVICE_SECRET_2,
    presharedKey: PRESHARED_KEY,
    osVersion: "IOS",
    modelFramework: "1",
  },
  signingKey: null,
};

/** Same shape as `serialize.test.ts`'s fixture — a coherent v1.2 receipt whose
 *  uuid and QR url come from the real wire/hash path, not a hand-typed
 *  constant, so the submitted envelope is the envelope a real sale produces. */
const ctx: WireContext = {
  rin: "200173707",
  sellerName: "ABC Corp",
  branchCode: "ABC",
  branchAddress: {
    country: "EG",
    governate: "Giza Governorate",
    regionCity: "Dokki",
    street: "17 Nabil Al Wakad",
    buildingNumber: "17",
  },
  deviceSerial: "POS-001",
  activityCode: "5610",
  receiptNumber: "1042",
};

const doc: FiscalDocument = {
  docType: "e_receipt",
  uuid: null,
  previousUuid: "c".repeat(64),
  referenceUuid: null,
  referenceOldUuid: null,
  buyer: { type: "P" },
  lines: [
    {
      itemCode: "10007020",
      internalCode: "11111111-1111-4111-8111-111111111111",
      codeSource: "gs1",
      taxType: "T1",
      taxSubType: "V001",
      unitType: "EA",
      description: "Shawarma Plate",
      quantity: 2,
      unitPrice: "85.00",
      discountAmount: "20.00",
      taxes: [{ taxType: "T1", taxSubType: "V001", rate: "14", amount: "21.00" }],
      lineTotal: "150.00",
    },
  ],
  subtotal: "150.00",
  discountTotal: "0.00",
  feesTotal: "0.00",
  taxTotals: [{ taxType: "T1", taxSubType: "V001", rate: "14", amount: "21.00" }],
  total: "171.00",
  paymentMethodCode: "C",
  currency: "EGP",
  issuedAt: "2026-07-24T09:30:15Z",
};

const finalized = finalizeReceipt(doc, ctx, { portalBase: PREPROD.portalBase });

type Call = { url: string; init: RequestInit };

function headersOf(call: Call): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The documented success body: access_token / token_type / expires_in. */
function tokenOk(): Response {
  return jsonResponse(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
}

/**
 * A routed fetch stub: anything hitting `/connect/token` is answered by
 * `token`, everything else consumes the next queued API responder in order.
 * Responders are factories, not `Response` values, because a body can only be
 * read once.
 */
function makeHttp(opts: { token?: () => Response; api?: (() => Response)[] } = {}) {
  const calls: Call[] = [];
  const queue = [...(opts.api ?? [])];
  const http: FetchLike = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/connect/token")) return (opts.token ?? tokenOk)();
    const next = queue.shift();
    if (!next) throw new Error(`unexpected API call: ${url}`);
    return next();
  };
  return { http, calls, tokenCalls: () => calls.filter((c) => c.url.endsWith("/connect/token")).length };
}

/** Nothing a taxpayer's ETA identity depends on may reach a persisted value. */
function expectNoAuthMaterial(value: unknown) {
  const serialized = JSON.stringify(value ?? null);
  for (const secret of [ACCESS_TOKEN, PRESHARED_KEY, DEVICE_SECRET_1, DEVICE_SECRET_2, ERP_SECRET]) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized.toLowerCase()).not.toContain("authorization");
  expect(serialized.toLowerCase()).not.toContain("bearer ");
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EtaFiscalProvider token acquisition (Authenticate POS)", () => {
  it("sends all four POS headers and form-encodes the credentials, with no scope", async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(202, { submissionUUID: "SUB-1" })] });
    await new EtaFiscalProvider(http).submit(finalized, cfg);

    const token = calls[0];
    expect(token.url).toBe(TOKEN_URL);
    expect(token.init.method).toBe("POST");

    // The four headers the Authenticate POS page's header table lists, each
    // with its own documented rejection code (invalid_posserial, ...).
    const headers = headersOf(token);
    expect(headers.posserial).toBe("POS-001");
    expect(headers.pososversion).toBe("IOS");
    expect(headers.posmodelframework).toBe("1");
    expect(headers.presharedkey).toBe(PRESHARED_KEY);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    // OAuth2 client credentials in the body, exactly the page's three body
    // parameters. Secret 1 is the one sent; Secret 2 is the rotation spare.
    const form = new URLSearchParams(String(token.init.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe("device-client-id");
    expect(form.get("client_secret")).toBe(DEVICE_SECRET_1);
    expect(form.get("scope")).toBeNull();
    expect(String(token.init.body)).not.toContain(DEVICE_SECRET_2);

    // No Basic header on the POS login — that belongs to the ERP login only.
    expect(headers.Authorization).toBeUndefined();
  });

  it("reuses a cached token within its TTL instead of logging in per call", async () => {
    const { http, tokenCalls } = makeHttp({
      api: [
        () => jsonResponse(202, { submissionUUID: "SUB-1" }),
        () => jsonResponse(202, { submissionUUID: "SUB-2" }),
      ],
    });
    const provider = new EtaFiscalProvider(http);
    await provider.submit(finalized, cfg);
    await provider.submit(finalized, cfg);

    expect(tokenCalls()).toBe(1);
  });

  it("re-authenticates once the token's expires_in has elapsed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T09:00:00Z"));

    const { http, tokenCalls } = makeHttp({
      api: [
        () => jsonResponse(202, { submissionUUID: "SUB-1" }),
        () => jsonResponse(202, { submissionUUID: "SUB-2" }),
      ],
    });
    const provider = new EtaFiscalProvider(http);
    await provider.submit(finalized, cfg);
    expect(tokenCalls()).toBe(1);

    // Past the 3600s lifetime, so even the safety margin cannot save it.
    vi.setSystemTime(new Date("2026-07-24T10:05:00Z"));
    await provider.submit(finalized, cfg);
    expect(tokenCalls()).toBe(2);
  });

  it("surfaces invalid_posserial as a permanent EtaConfigError, not a retryable one", async () => {
    const { http } = makeHttp({
      token: () => jsonResponse(400, { error: "invalid_posserial", error_description: "User blocked" }),
    });

    const error = await new EtaFiscalProvider(http).submit(finalized, cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaConfigError);
    expect(error).not.toBeInstanceOf(EtaTransportError);
    expect((error as EtaConfigError).code).toBe("invalid_posserial");
    expect((error as EtaConfigError).message).toContain("User blocked");
    expectNoAuthMaterial((error as EtaConfigError).message);
  });

  it("refuses to call ETA at all when the device has no pre-shared key", async () => {
    const { http, calls } = makeHttp();
    const noKey: EtaConfig = { ...cfg, device: { ...cfg.device!, presharedKey: null } };

    const error = await new EtaFiscalProvider(http).submit(finalized, noKey).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaConfigError);
    expect((error as EtaConfigError).code).toBe("device-preshared-key-missing");
    // Fail fast: a provisioning gap must not cost a round trip, and must not
    // come back as an ambiguous invalid_presharedkey.
    expect(calls).toHaveLength(0);
  });

  it("uses the ERP Basic login when there is no device credential", async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(202, { submissionUUID: "SUB-1" })] });
    await new EtaFiscalProvider(http).submit(finalized, { ...cfg, device: null });

    const headers = headersOf(calls[0]);
    const expected = Buffer.from(`erp-client-id:${ERP_SECRET}`, "utf8").toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expected}`);
    expect(headers.posserial).toBeUndefined();

    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("InvoicingAPI");
    // Credentials travel in the Basic header, not the body (RFC 6749 forbids
    // using two client-authentication methods in one request).
    expect(form.get("client_secret")).toBeNull();
  });
});

describe("EtaFiscalProvider.submit", () => {
  it("posts {receipts:[document]} with no signatures element and unquoted decimals", async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(202, { submissionUUID: "SUB-1" })] });
    await new EtaFiscalProvider(http).submit(finalized, cfg);

    const submit = calls[1];
    expect(submit.url).toBe(SUBMIT_URL);
    expect(submit.init.method).toBe("POST");
    expect(headersOf(submit)["Content-Type"]).toBe("application/json");
    expect(headersOf(submit).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    const body = String(submit.init.body);
    expect(body).toBe(`{"receipts":[${stringifyWire(finalized.wire)}]}`);

    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["receipts"]);
    expect(parsed).not.toHaveProperty("signatures");
    // F9: money literals must survive as JSON numbers, not strings.
    expect(body).toContain('"totalAmount":171.00');
    // The transmitted uuid is the one that was hashed.
    expect((parsed.receipts as { header: { uuid: string } }[])[0].header.uuid).toBe(finalized.uuid);
  });

  it("maps a 202 to submitted, carrying submissionUUID and the assigned longId", async () => {
    const accepted = {
      submissionUUID: "TZRKK8MFZCPSTW9XCYWBMKME10",
      acceptedDocuments: [{ uuid: finalized.uuid, longId: "BFNGXFA17265TQX34", receiptNumber: "1042" }],
      rejectedDocuments: [],
    };
    const { http } = makeHttp({ api: [() => jsonResponse(202, accepted)] });

    const result = await new EtaFiscalProvider(http).submit(finalized, cfg);
    // 202 is "accepted for further processing", never a terminal verdict.
    expect(result.status).toBe("submitted");
    expect(result.submissionUuid).toBe("TZRKK8MFZCPSTW9XCYWBMKME10");
    expect(result.etaUuid).toBe(finalized.uuid);
    expect(result.etaLongId).toBe("BFNGXFA17265TQX34");
    expect(result.qrPayload).toBe(finalized.qrUrl);
    expect(result.responseJson).toEqual(accepted);
    expectNoAuthMaterial(result.responseJson);
  });

  it("maps an immediate per-document rejection to rejected, capturing ETA's errors", async () => {
    const body = {
      submissionUUID: "SUB-9",
      acceptedDocuments: [],
      rejectedDocuments: [
        {
          receiptNumber: "1042",
          uuid: finalized.uuid,
          error: {
            message: "Issuance date time value is out of the range of submission workflow parameter",
            target: finalized.uuid,
            propertyPath: "receipts.datetimeissued",
            details: [],
          },
        },
      ],
    };
    const { http } = makeHttp({ api: [() => jsonResponse(202, body)] });

    const result = await new EtaFiscalProvider(http).submit(finalized, cfg);
    expect(result.status).toBe("rejected");
    expect(result.etaUuid).toBe(finalized.uuid);
    expect(result.responseJson).toEqual(body);
    expect(JSON.stringify(result.responseJson)).toContain("out of the range");
    expectNoAuthMaterial(result.responseJson);
  });

  it("redacts anything auth-shaped that appears in a response body", async () => {
    const { http } = makeHttp({
      api: [
        () =>
          jsonResponse(202, {
            submissionUUID: "SUB-1",
            // Not a documented ETA field — the belt-and-braces net for a
            // proxy or an undocumented field echoing credentials back.
            access_token: ACCESS_TOKEN,
            nested: { presharedKey: PRESHARED_KEY },
          }),
      ],
    });

    const result = await new EtaFiscalProvider(http).submit(finalized, cfg);
    expect(result.responseJson).toMatchObject({
      access_token: REDACTED,
      nested: { presharedKey: REDACTED },
    });
    expectNoAuthMaterial(result.responseJson);
  });

  it("redacts credential-shaped keys in every spelling, at any depth", async () => {
    // An exact-match key list missed all six of these. responseJson is
    // PERSISTED to eta_submissions, so a miss is a durable leak — hence
    // substring matching, and hence these probes.
    const { http } = makeHttp({
      api: [
        () =>
          jsonResponse(202, {
            submissionUUID: "SUB-1",
            posPresharedKey: PRESHARED_KEY,
            deep: {
              deeper: {
                "client-secret": DEVICE_SECRET_1,
                "X-Api-Key": "APIKEY-must-never-be-persisted",
                apiKey: "APIKEY-must-never-be-persisted",
                signingKey: "SIGNING-must-never-be-persisted",
                list: [{ clientSecret1: DEVICE_SECRET_1, clientSecret2: DEVICE_SECRET_2 }],
              },
            },
          }),
      ],
    });

    const result = await new EtaFiscalProvider(http).submit(finalized, cfg);
    const deeper = (result.responseJson.deep as { deeper: Record<string, unknown> }).deeper;
    expect(result.responseJson.posPresharedKey).toBe(REDACTED);
    expect(deeper["client-secret"]).toBe(REDACTED);
    expect(deeper["X-Api-Key"]).toBe(REDACTED);
    expect(deeper.apiKey).toBe(REDACTED);
    expect(deeper.signingKey).toBe(REDACTED);
    expect(deeper.list).toEqual([{ clientSecret1: REDACTED, clientSecret2: REDACTED }]);

    expectNoAuthMaterial(result.responseJson);
    expect(JSON.stringify(result.responseJson)).not.toContain("APIKEY-must-never-be-persisted");
    expect(JSON.stringify(result.responseJson)).not.toContain("SIGNING-must-never-be-persisted");
    // A field that merely mentions a receipt is untouched — only key NAMES are
    // matched, never values.
    expect(result.responseJson.submissionUUID).toBe("SUB-1");
  });

  it("throws a retryable EtaTransportError with Retry-After seconds on a 429", async () => {
    const { http } = makeHttp({
      api: [
        () =>
          jsonResponse(
            429,
            { error: "Too many requests", message: "Your system has sent too many requests", code: 429 },
            { "retry-after": "42", correlationid: "JHDSJ8882POY72SG-2828" },
          ),
      ],
    });

    const error = await new EtaFiscalProvider(http).submit(finalized, cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    const transport = error as EtaTransportError;
    expect(transport.status).toBe(429);
    expect(transport.retryAfterSeconds).toBe(42);
    expect(transport.correlationId).toBe("JHDSJ8882POY72SG-2828");
    // APIs Governance publishes the throttling body with a NUMERIC code; it
    // must still reach the worker as a discriminator, not be dropped.
    expect(transport.etaErrorCode).toBe("429");
    expectNoAuthMaterial(transport.body);
    expectNoAuthMaterial(transport.message);
  });

  it("prefers a nested string error code over a flat numeric one", async () => {
    const { http } = makeHttp({
      api: [
        () =>
          jsonResponse(400, {
            error: { code: "MaximumSizeExceeded", message: "submission too large" },
            code: 400,
          }),
      ],
    });

    const error = await new EtaFiscalProvider(http).submit(finalized, cfg).catch((e: unknown) => e);
    // "MaximumSizeExceeded" says more than "400".
    expect((error as EtaTransportError).etaErrorCode).toBe("MaximumSizeExceeded");
  });

  it("throws a retryable EtaTransportError on a 503", async () => {
    const { http } = makeHttp({
      api: [() => jsonResponse(503, { error: "Too many requests", message: "temporary overload", code: 503 })],
    });

    const error = await new EtaFiscalProvider(http).submit(finalized, cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).status).toBe(503);
    expect((error as EtaTransportError).retryAfterSeconds).toBeNull();
    // Same flat, numeric-coded envelope as the 429.
    expect((error as EtaTransportError).etaErrorCode).toBe("503");
  });

  it("carries ETA's error code through a 400 BadStructure without calling it a rejection", async () => {
    const { http } = makeHttp({
      api: [
        () =>
          jsonResponse(400, {
            error: { code: "BadStructure", message: "Structural error with the submission message" },
          }),
      ],
    });

    const error = await new EtaFiscalProvider(http).submit(finalized, cfg).catch((e: unknown) => e);
    // The page reserves per-document rejection for the 202 body, so a 400 is
    // never mapped to status "rejected" — see EtaTransportError's JSDoc.
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).etaErrorCode).toBe("BadStructure");
  });

  it("turns a network failure into an EtaTransportError rather than a raw TypeError", async () => {
    const http: FetchLike = async (input) => {
      if (String(input).endsWith("/connect/token")) return tokenOk();
      throw new TypeError("fetch failed");
    };

    const error = await new EtaFiscalProvider(http).submit(finalized, cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).status).toBeNull();
  });

  it("abandons a hanging request as a retryable timeout rather than waiting forever", async () => {
    // A connection that opens and then goes silent. The stub honours the
    // AbortSignal exactly as a real fetch does — which is the point of the
    // test: nothing here rejects on its own, so only the provider's own
    // deadline can end it. Without one, Node's fetch would hang until the peer
    // or the OS gave up, holding the worker's claim lease the whole time.
    let sawSignal = false;
    const hanging: FetchLike = (input, init) => {
      if (String(input).endsWith("/connect/token")) return Promise.resolve(tokenOk());
      sawSignal = init?.signal instanceof AbortSignal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    };

    // 50ms rather than the real 60s so the suite does not wait a minute; the
    // deadline is the behaviour under test, not its exact value.
    const provider = new EtaFiscalProvider(hanging, { timeoutMs: 50 });
    const error = await provider.submit(finalized, cfg).catch((e: unknown) => e);

    expect(sawSignal).toBe(true);
    // RETRYABLE: an abandoned request says nothing about whether the document
    // was judged, so it must never become a terminal "rejected".
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).status).toBeNull();
    expect((error as EtaTransportError).message).toMatch(/timed out after 50ms/);
    // The cause is preserved for the logs, redacted of nothing — it carries no
    // credential material.
    expect(((error as EtaTransportError).cause as Error).name).toBe("TimeoutError");
  });

  it("applies the deadline to the token call too, not just the API call", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });

    const provider = new EtaFiscalProvider(hanging, { timeoutMs: 50 });
    const error = await provider.submit(finalized, cfg).catch((e: unknown) => e);

    // A hung /connect/token is the same class of failure — the login is the
    // first thing a submission does, so an unbounded one strands the row just
    // as effectively.
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).message).toMatch(/timed out after 50ms/);
  });

  it("renews the token once on a 401 and retries the call", async () => {
    const { http, calls, tokenCalls } = makeHttp({
      api: [
        () => jsonResponse(401, { error: { code: "Unauthorized", message: "token expired" } }),
        () => jsonResponse(202, { submissionUUID: "SUB-AFTER-RENEW" }),
      ],
    });

    const result = await new EtaFiscalProvider(http).submit(finalized, cfg);
    expect(result.submissionUuid).toBe("SUB-AFTER-RENEW");
    // Fresh login, not the cached token: token, submit(401), token, submit(202).
    expect(tokenCalls()).toBe(2);
    expect(calls).toHaveLength(4);
  });

  it("issues ONE login when concurrent submissions race a cold cache", async () => {
    // A till flushing a queue of offline receipts hits submit N times at once.
    // Without single-flighting, that is N logins racing each other into ETA's
    // throttling, N-1 of them wasted.
    const { http, calls, tokenCalls } = makeHttp({
      api: [
        () => jsonResponse(202, { submissionUUID: "SUB-1" }),
        () => jsonResponse(202, { submissionUUID: "SUB-2" }),
        () => jsonResponse(202, { submissionUUID: "SUB-3" }),
      ],
    });
    const provider = new EtaFiscalProvider(http);

    const results = await Promise.all([
      provider.submit(finalized, cfg),
      provider.submit(finalized, cfg),
      provider.submit(finalized, cfg),
    ]);

    expect(tokenCalls()).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["submitted", "submitted", "submitted"]);
    // All three shared the one token.
    const submits = calls.filter((c) => !c.url.endsWith("/connect/token"));
    expect(submits.map((c) => headersOf(c).Authorization)).toEqual(Array(3).fill(`Bearer ${ACCESS_TOKEN}`));
  });

  it("does not double-login when concurrent calls both hit a 401", async () => {
    // Both requests carry the same expired token and both come back 401. Only
    // the caller whose token is still the cached one may invalidate it — a
    // blind delete would drop the replacement a sibling had just cached and
    // send everyone back to /connect/token again.
    let issued = 0;
    const { http, tokenCalls } = makeHttp({
      token: () =>
        jsonResponse(200, { access_token: `${ACCESS_TOKEN}-${++issued}`, token_type: "Bearer", expires_in: 3600 }),
      api: [
        () => jsonResponse(401, { error: { code: "Unauthorized", message: "token expired" } }),
        () => jsonResponse(401, { error: { code: "Unauthorized", message: "token expired" } }),
        () => jsonResponse(202, { submissionUUID: "SUB-A" }),
        () => jsonResponse(202, { submissionUUID: "SUB-B" }),
      ],
    });
    const provider = new EtaFiscalProvider(http);

    const results = await Promise.all([provider.submit(finalized, cfg), provider.submit(finalized, cfg)]);

    // One cold-cache login plus exactly one refresh — never a third.
    expect(tokenCalls()).toBe(2);
    expect(results.map((r) => r.submissionUuid).sort()).toEqual(["SUB-A", "SUB-B"]);
  });
});

describe("EtaFiscalProvider.poll", () => {
  const pollUrl = `${SUBMIT_URL}/SUB-1/details`;

  it("maps InProgress to submitted so the worker keeps polling", async () => {
    const { http, calls } = makeHttp({
      api: [() => jsonResponse(200, { submissionuuid: "SUB-1", status: "InProgress", receipts: [] })],
    });

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg);
    expect(calls[1].url).toBe(pollUrl);
    expect(calls[1].init.method).toBe("GET");
    expect(result.status).toBe("submitted");
    expect(result.submissionUuid).toBe("SUB-1");
  });

  it("maps a Valid receipt to accepted with its uuid and longId", async () => {
    const body = {
      submissionuuid: "SUB-1",
      status: "Valid",
      receiptsCount: 1,
      invalidReceiptCount: 0,
      receipts: [{ uuid: finalized.uuid, receiptNumber: "1042", status: "Valid", longId: "BFNGXFA17265TQX34" }],
    };
    const { http } = makeHttp({ api: [() => jsonResponse(200, body)] });

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg);
    expect(result.status).toBe("accepted");
    expect(result.etaUuid).toBe(finalized.uuid);
    expect(result.etaLongId).toBe("BFNGXFA17265TQX34");
    expect(result.responseJson).toEqual(body);
    expectNoAuthMaterial(result.responseJson);
  });

  it("maps an Invalid receipt to rejected, keeping the validation errors", async () => {
    const body = {
      submissionuuid: "SUB-1",
      status: "Invalid",
      invalidReceiptCount: 1,
      receipts: [
        {
          uuid: finalized.uuid,
          status: "Invalid",
          errors: [{ propertyPath: "$.itemData[*].taxableItems[*].taxType", errorCode: "CV307", error: "ItemCode [W001] doesn't belong to ParentCode [T3]" }],
        },
      ],
    };
    const { http } = makeHttp({ api: [() => jsonResponse(200, body)] });

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg);
    expect(result.status).toBe("rejected");
    expect(result.etaUuid).toBe(finalized.uuid);
    expect(JSON.stringify(result.responseJson)).toContain("CV307");
  });

  it("maps a Cancelled receipt to accepted — it was validated, then withdrawn", async () => {
    const { http } = makeHttp({
      api: [
        () =>
          jsonResponse(200, {
            status: "Valid",
            receipts: [{ uuid: finalized.uuid, status: "Cancelled", longId: "BFNGXFA17265TQX34" }],
          }),
      ],
    });

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg);
    expect(result.status).toBe("accepted");
    expect(JSON.stringify(result.responseJson)).toContain("Cancelled");
  });

  it("falls back to the submission-level verdict when no receipt row came back", async () => {
    const { http } = makeHttp({
      api: [
        () =>
          jsonResponse(200, {
            status: "Invalid",
            receipts: [],
            submissionErrors: [{ stepId: "20", stepName: "Step 04" }],
          }),
      ],
    });

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg);
    expect(result.status).toBe("rejected");
  });

  it("refuses to guess at an undocumented submission status", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(200, { status: "PartiallyValid", receipts: [] })] });

    const error = await new EtaFiscalProvider(http).poll("SUB-1", cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).message).toContain("PartiallyValid");
  });

  it("throws a retryable EtaTransportError on a 500", async () => {
    const { http } = makeHttp({
      api: [() => jsonResponse(500, { error: { code: "InternalServerError", message: "boom" } })],
    });

    const error = await new EtaFiscalProvider(http).poll("SUB-1", cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).status).toBe(500);
    expect((error as EtaTransportError).etaErrorCode).toBe("InternalServerError");
  });
});

describe("buildSubmissionBody", () => {
  it("omits signatures entirely when none is supplied, matching ETA's own samples", () => {
    expect(buildSubmissionBody(finalized.wire)).toBe(`{"receipts":[${stringifyWire(finalized.wire)}]}`);
  });

  it("carries a signatures array when one is supplied (the seam for a future signer)", () => {
    const body = buildSubmissionBody(finalized.wire, [{ signatureType: "I", value: "BASE64" }]);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["receipts", "signatures"]);
    expect(parsed.signatures).toEqual([{ signatureType: "I", value: "BASE64" }]);
  });
});
