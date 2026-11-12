import { describe, it, expect, afterEach, vi } from "vitest";
import { EtaFiscalProvider, buildSubmissionBody, buildDocumentSubmissionBody, type FetchLike } from "./eta-provider";
import { EtaTransportError, EtaConfigError, REDACTED } from "./eta-transport-errors";
import { getEtaEnv } from "./eta-env";
import { finalizeReceipt, type WireContext } from "./eta-wire";
import { stringifyWire } from "./serialize";
import { dec } from "./decimal";
import type { FiscalDocument, FinalizedFiscalDocument, EtaConfig } from "./provider";

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
  signingKey: () => null,
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

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt");
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

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt");
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

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt");
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

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt");
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

    const result = await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt");
    expect(result.status).toBe("rejected");
  });

  it("refuses to guess at an undocumented submission status", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(200, { status: "PartiallyValid", receipts: [] })] });

    const error = await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).message).toContain("PartiallyValid");
  });

  it("throws a retryable EtaTransportError on a 500", async () => {
    const { http } = makeHttp({
      api: [() => jsonResponse(500, { error: { code: "InternalServerError", message: "boom" } })],
    });

    const error = await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as EtaTransportError).status).toBe(500);
    expect((error as EtaTransportError).etaErrorCode).toBe("InternalServerError");
  });
});

describe("EtaFiscalProvider.lookupReceipt (Get Receipt Details)", () => {
  const lookupUrl = `${PREPROD.apiBase}/api/v1/receipts/${finalized.uuid}/details`;

  it("GETs /api/v1/receipts/{uuid}/details under the device token", async () => {
    const { http, calls } = makeHttp({
      api: [() => jsonResponse(200, { submissionUUID: "SUB-1", receipt: { uuid: finalized.uuid, longId: "L-1", status: "valid" } })],
    });
    await new EtaFiscalProvider(http).lookupReceipt(finalized.uuid!, cfg);
    expect(calls[1].url).toBe(lookupUrl);
    expect(calls[1].init.method).toBe("GET");
    expect(headersOf(calls[1]).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // The POS login, not the ERP one.
    expect(headersOf(calls[0]).posserial).toBe("POS-001");
  });

  it("returns null on a 404 — ETA does not hold the receipt, so it is safe to send", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(404, { error: { code: "NotFound", message: "not found" } })] });
    expect(await new EtaFiscalProvider(http).lookupReceipt(finalized.uuid!, cfg)).toBeNull();
  });

  it("maps a held valid receipt to accepted, with its submission handle and longId", async () => {
    const { http } = makeHttp({
      api: [() => jsonResponse(200, { submissionUUID: "SUB-9", receipt: { uuid: finalized.uuid, longId: "L-9", status: "Valid" } })],
    });
    const result = await new EtaFiscalProvider(http).lookupReceipt(finalized.uuid!, cfg);
    expect(result).toMatchObject({ status: "accepted", submissionUuid: "SUB-9", etaUuid: finalized.uuid, etaLongId: "L-9" });
    expectNoAuthMaterial(result!.responseJson);
  });

  it("maps a held receipt with no verdict yet to submitted so the worker polls its handle", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(200, { submissionUUID: "SUB-2", receipt: { uuid: finalized.uuid, status: "Submitted" } })] });
    const result = await new EtaFiscalProvider(http).lookupReceipt(finalized.uuid!, cfg);
    expect(result).toMatchObject({ status: "submitted", submissionUuid: "SUB-2" });
  });

  it("throws a retryable EtaTransportError on a 500 rather than reading it as not-found", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(500, { error: { code: "InternalError" } })] });
    await expect(new EtaFiscalProvider(http).lookupReceipt(finalized.uuid!, cfg)).rejects.toBeInstanceOf(EtaTransportError);
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

// ---------------------------------------------------------------------------
// B2B invoices — the ERP path (round 2 Task 3)
// ---------------------------------------------------------------------------

/**
 * `{"documents":[...]}` against `/api/v1.0/documentsubmissions/`, authenticated
 * through Login as Taxpayer System rather than Authenticate POS. Every shape
 * below is transcribed from
 * https://sdk.invoicing.eta.gov.eg/einvoicingapi/01-submit-documents/ and
 * .../09-get-submission/.
 */
const INVOICE_SUBMIT_URL = `${PREPROD.apiBase}/api/v1.0/documentsubmissions/`;

/** A minimal but structurally real invoice wire document. The mapper's own
 *  output is covered exhaustively in `build-invoice.test.ts`; what matters here
 *  is that `internalID` is present, since it is the only key ETA's response can
 *  be matched on. */
const invoiceWire: Record<string, unknown> = {
  issuer: { address: { country: "EG" }, type: "B", id: "200173707", name: "ABC Corp" },
  receiver: { address: { country: "EG" }, type: "B", id: "313717919", name: "Receiver" },
  documentType: "I",
  documentTypeVersion: "0.9",
  dateTimeIssued: "2026-07-24T09:30:15Z",
  taxpayerActivityCode: "5610",
  internalID: "1042",
  invoiceLines: [],
  totalDiscountAmount: dec("0.00"),
  totalSalesAmount: dec("150.00"),
  netAmount: dec("150.00"),
  taxTotals: [{ taxType: "T1", amount: dec("21.00") }],
  totalAmount: dec("171.00"),
  extraDiscountAmount: dec("0.00"),
  totalItemsDiscountAmount: dec("0.00"),
};

/** An invoice reaches `submit` with NO uuid and NO QR — ETA assigns the first
 *  and there is no template for the second. */
const finalizedInvoice: FinalizedFiscalDocument = {
  docType: "e_invoice",
  wire: invoiceWire,
  uuid: null,
  qrUrl: null,
};

/** The signed form: documentTypeVersion 1.0 with a `signatures` element INSIDE
 *  the document, which is where invoice v1.0 puts it. */
const finalizedSignedInvoice: FinalizedFiscalDocument = {
  ...finalizedInvoice,
  wire: {
    ...invoiceWire,
    documentTypeVersion: "1.0",
    signatures: [{ signatureType: "I", value: "MIIGywYJKoZIhvcNAQcCoIIGvDCC-stub" }],
  },
};

describe("EtaFiscalProvider.submit — B2B invoice over the ERP credential", () => {
  it("authenticates with Login as Taxpayer System, never the POS login, even when a device is configured", async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(202, { submissionUUID: "SUB-INV-1" })] });
    // `cfg` carries a full DEVICE credential. An invoice must still go through
    // the ERP login — that is the whole point of the forced downgrade in
    // `#submitInvoice`.
    await new EtaFiscalProvider(http).submit(finalizedInvoice, cfg);

    const token = calls[0];
    expect(token.url).toBe(TOKEN_URL);
    const headers = headersOf(token);
    // HTTP Basic, per the ERP page: "Must contain basic authorization string
    // created using issued Client ID and Client Secret for the ERP system."
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`erp-client-id:${ERP_SECRET}`, "utf8").toString("base64")}`);
    // And none of the four POS headers.
    for (const posHeader of ["posserial", "pososversion", "posmodelframework", "presharedkey"]) {
      expect(headers[posHeader], posHeader).toBeUndefined();
    }
    const form = new URLSearchParams(String(token.init.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("InvoicingAPI");
  });

  it('posts {"documents":[...]} to /api/v1.0/documentsubmissions/ with the exact wire bytes', async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(202, { submissionUUID: "SUB-INV-1" })] });
    await new EtaFiscalProvider(http).submit(finalizedInvoice, cfg);

    const submit = calls[1];
    expect(submit.url).toBe(INVOICE_SUBMIT_URL);
    expect(submit.init.method).toBe("POST");
    expect(headersOf(submit)["Content-Type"]).toBe("application/json");
    expect(headersOf(submit).Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    // The envelope snapshot: the document goes out verbatim, decimals unquoted
    // and with their trailing zeros intact.
    expect(String(submit.init.body)).toBe(`{"documents":[${stringifyWire(invoiceWire)}]}`);
    expect(String(submit.init.body)).toContain('"totalAmount":171.00');
    expect(String(submit.init.body)).toContain('"documentTypeVersion":"0.9"');
    // No `receipts` key, and no signatures alongside the document.
    expect(String(submit.init.body)).not.toContain('"receipts"');
    expect(JSON.parse(String(submit.init.body))).toHaveProperty("documents");
  });

  it("carries documentTypeVersion 1.0 and its signatures INSIDE the document when a signer produced one", async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(202, { submissionUUID: "SUB-INV-1" })] });
    await new EtaFiscalProvider(http).submit(finalizedSignedInvoice, cfg);

    const body = JSON.parse(String(calls[1].init.body)) as { documents: Record<string, unknown>[] };
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0].documentTypeVersion).toBe("1.0");
    // Invoice v1.0 lists `signatures` as a member of the DOCUMENT; the receipt
    // API instead documents it beside `receipts`. This is that difference.
    expect(body.documents[0].signatures).toEqual([{ signatureType: "I", value: "MIIGywYJKoZIhvcNAQcCoIIGvDCC-stub" }]);
    expect(Object.keys(body)).toEqual(["documents"]);
  });

  it("maps a 202 to submitted and carries ETA's ASSIGNED uuid and longId through", async () => {
    const accepted = {
      submissionUUID: "TZRKK8MFZCPSTW9XCYWBMKME10",
      acceptedDocuments: [{
        uuid: "TZRKK8MFZCPSTW9XCYWBMKME11",
        longId: "TZRKK8MFZ CPSTW9XC YWBMKME10A BC123160 2681697",
        internalId: "1042",
      }],
      rejectedDocuments: [],
    };
    const { http } = makeHttp({ api: [() => jsonResponse(202, accepted)] });
    const result = await new EtaFiscalProvider(http).submit(finalizedInvoice, cfg);

    expect(result.status).toBe("submitted");
    expect(result.submissionUuid).toBe("TZRKK8MFZCPSTW9XCYWBMKME10");
    expect(result.etaUuid).toBe("TZRKK8MFZCPSTW9XCYWBMKME11");
    expect(result.etaLongId).toBe("TZRKK8MFZ CPSTW9XC YWBMKME10A BC123160 2681697");
    // THE NO-QR INVARIANT.
    expect(result.qrPayload).toBeUndefined();
    expectNoAuthMaterial(result.responseJson);
  });

  it("matches on internalId, ignoring another document in the same response", async () => {
    const mixed = {
      submissionUUID: "SUB-INV-1",
      acceptedDocuments: [
        { uuid: "OTHER-UUID", longId: "OTHER-LONG", internalId: "9999" },
        { uuid: "OURS", longId: "OURS-LONG", internalId: "1042" },
      ],
    };
    const { http } = makeHttp({ api: [() => jsonResponse(202, mixed)] });
    const result = await new EtaFiscalProvider(http).submit(finalizedInvoice, cfg);
    expect(result.etaUuid).toBe("OURS");
  });

  it("maps a rejectedDocuments entry to the terminal rejected, with no invented uuid", async () => {
    const rejected = {
      submissionUUID: "SUB-INV-1",
      acceptedDocuments: [],
      rejectedDocuments: [{
        internalId: "1042",
        error: { code: "BadArgument", message: "receiver id is not registered", target: "receiver.id", details: [] },
      }],
    };
    const { http } = makeHttp({ api: [() => jsonResponse(202, rejected)] });
    const result = await new EtaFiscalProvider(http).submit(finalizedInvoice, cfg);

    expect(result.status).toBe("rejected");
    expect(result.etaUuid).toBeUndefined();
    expect(result.responseJson).toEqual(rejected);
  });

  it("treats a 202 with no submissionUUID as retryable — an invoice with no handle can never be reconciled", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(202, { acceptedDocuments: [] })] });
    const error = await new EtaFiscalProvider(http).submit(finalizedInvoice, cfg).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as Error).message).toContain("no submissionUUID");
  });

  it("maps every documented non-202 to a transport error carrying ETA's own code", async () => {
    for (const [status, code] of [[400, "BadStructure"], [403, "IncorrectSubmitter"], [422, "DuplicateSubmission"]] as const) {
      const { http } = makeHttp({ api: [() => jsonResponse(status, { error: { code, message: "refused" } })] });
      const error = await new EtaFiscalProvider(http).submit(finalizedInvoice, cfg).catch((e: unknown) => e);
      expect(error, code).toBeInstanceOf(EtaTransportError);
      expect((error as EtaTransportError).status, code).toBe(status);
      expect((error as EtaTransportError).etaErrorCode, code).toBe(code);
    }
  });

  it("refuses to submit a document with no internalID rather than matching nothing in the response", async () => {
    const noInternalId: FinalizedFiscalDocument = {
      ...finalizedInvoice,
      wire: Object.fromEntries(Object.entries(invoiceWire).filter(([key]) => key !== "internalID")),
    };
    const { http } = makeHttp({ api: [() => jsonResponse(202, { submissionUUID: "SUB-INV-1" })] });
    await expect(new EtaFiscalProvider(http).submit(noInternalId, cfg)).rejects.toThrow(/no internalID/);
  });
});

describe("EtaFiscalProvider.poll — B2B invoice (Get Submission)", () => {
  const POLL_URL = `${INVOICE_SUBMIT_URL}SUB-INV-1`;

  /** ETA's documented Get Submission body, with the per-document row that
   *  carries the verdict. */
  const submission = (overall: string, documentStatus?: string) => ({
    uuid: "SUB-INV-1",
    documentCount: 1,
    dateTimeReceived: "2026-07-24T09:31:00Z",
    overallStatus: overall,
    ...(documentStatus === undefined
      ? {}
      : {
          documentSummary: [{
            uuid: "F9D425P6DS7D8IU",
            longId: "LONG-INV-1",
            internalId: "1042",
            typeName: "i",
            status: documentStatus,
            issuerId: "200173707",
            total: 171.0,
          }],
        }),
  });

  it("GETs /api/v1.0/documentsubmissions/{uuid} — no /details suffix — under the ERP token", async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(200, submission("valid", "valid"))] });
    await new EtaFiscalProvider(http).poll("SUB-INV-1", cfg, "e_invoice");

    expect(calls[1].url).toBe(POLL_URL);
    expect(calls[1].init.method).toBe("GET");
    expect(headersOf(calls[0]).Authorization).toContain("Basic ");
  });

  it("maps a valid document to accepted, carrying ETA's assigned uuid and longId", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(200, submission("valid", "valid"))] });
    const result = await new EtaFiscalProvider(http).poll("SUB-INV-1", cfg, "e_invoice");

    expect(result.status).toBe("accepted");
    expect(result.etaUuid).toBe("F9D425P6DS7D8IU");
    expect(result.etaLongId).toBe("LONG-INV-1");
    expect(result.qrPayload).toBeUndefined();
  });

  it('maps "in progress" to submitted without consuming the verdict', async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(200, submission("in progress"))] });
    const result = await new EtaFiscalProvider(http).poll("SUB-INV-1", cfg, "e_invoice");
    expect(result.status).toBe("submitted");
  });

  it("maps every documented per-document status to its verdict", async () => {
    const expected: [string, string][] = [
      ["valid", "accepted"],
      // A cancelled document was validated and later withdrawn; the status enum
      // has no cancelled member and recording it as rejected would misstate the
      // fiscal record.
      ["cancelled", "accepted"],
      ["invalid", "rejected"],
      ["rejected", "rejected"],
      ["submitted", "submitted"],
    ];
    for (const [documentStatus, status] of expected) {
      const { http } = makeHttp({ api: [() => jsonResponse(200, submission("valid", documentStatus))] });
      const result = await new EtaFiscalProvider(http).poll("SUB-INV-1", cfg, "e_invoice");
      expect(result.status, documentStatus).toBe(status);
    }
  });

  it("accepts ETA's capitalisation either way — the two API families document the same words differently", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(200, submission("Valid", "Valid"))] });
    expect((await new EtaFiscalProvider(http).poll("SUB-INV-1", cfg, "e_invoice")).status).toBe("accepted");
  });

  it("falls back to the submission's own verdict when there is no per-document row", async () => {
    for (const [overall, status] of [["valid", "accepted"], ["invalid", "rejected"]] as const) {
      const { http } = makeHttp({ api: [() => jsonResponse(200, submission(overall))] });
      expect((await new EtaFiscalProvider(http).poll("SUB-INV-1", cfg, "e_invoice")).status, overall).toBe(status);
    }
  });

  it("refuses to guess at an unrecognised status rather than filing a verdict nobody published", async () => {
    const { http } = makeHttp({ api: [() => jsonResponse(200, submission("valid", "quarantined"))] });
    const error = await new EtaFiscalProvider(http).poll("SUB-INV-1", cfg, "e_invoice").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaTransportError);
    expect((error as Error).message).toContain("not mapped rather than guessed");
  });

  it("still polls the RECEIPT endpoint for a receipt, so the two families cannot be confused", async () => {
    const { http, calls } = makeHttp({ api: [() => jsonResponse(200, { status: "InProgress" })] });
    await new EtaFiscalProvider(http).poll("SUB-1", cfg, "e_receipt");
    expect(calls[1].url).toBe(`${PREPROD.apiBase}/api/v1/receiptsubmissions/SUB-1/details`);
  });
});

describe("buildDocumentSubmissionBody", () => {
  it("wraps the document in ETA's documents envelope, decimals verbatim", () => {
    expect(buildDocumentSubmissionBody(invoiceWire)).toBe(`{"documents":[${stringifyWire(invoiceWire)}]}`);
  });
});
