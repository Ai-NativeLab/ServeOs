import { describe, it, expect, vi, afterEach } from "vitest";
import { publishTenantEvent, tenantTopic } from "./publish";

const URL_ = "https://proj.supabase.co";
const KEY = "service-role-key";

function configure() {
  vi.stubEnv("SUPABASE_URL", URL_);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", KEY);
}

function stubFetch(impl?: (...args: unknown[]) => Promise<Response>) {
  const fn = vi.fn(impl ?? (async () => new Response(null, { status: 202 })));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("publishTenantEvent", () => {
  it("posts one IDs-only message to the tenant's private topic", async () => {
    configure();
    const fetchMock = stubFetch();

    await publishTenantEvent("t-1", { type: "orders.changed", entityIds: ["o-1", "o-2"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${URL_}/realtime/v1/api/broadcast`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ apikey: KEY, Authorization: `Bearer ${KEY}` });
    expect(JSON.parse(String(init.body))).toEqual({
      messages: [
        {
          topic: "tenant:t-1",
          event: "orders.changed",
          payload: { entityIds: ["o-1", "o-2"] },
          private: true,
        },
      ],
    });
  });

  it("carries no domain data — only ids the subscriber then refetches", async () => {
    configure();
    const fetchMock = stubFetch();

    await publishTenantEvent("t-1", { type: "sync.applied", entityIds: ["o-9"] });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(Object.keys(body.messages[0].payload)).toEqual(["entityIds"]);
  });

  it("is a no-op without Supabase config — dev and CI never reach the network", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const fetchMock = stubFetch();

    await publishTenantEvent("t-1", { type: "stock.changed", entityIds: [] });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a transport failure — the caller's write must not fail on a broadcast", async () => {
    configure();
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(
      publishTenantEvent("t-1", { type: "orders.changed", entityIds: ["o-1"] }),
    ).resolves.toBeUndefined();
  });

  it("swallows a rejected broadcast (bad key, missing project) the same way", async () => {
    configure();
    stubFetch(async () => new Response(JSON.stringify({ error: "invalid" }), { status: 401 }));

    await expect(
      publishTenantEvent("t-1", { type: "orders.changed", entityIds: ["o-1"] }),
    ).resolves.toBeUndefined();
  });

  it("gives up rather than holding the request open forever", async () => {
    configure();
    // Resolves only when the publisher's own AbortSignal fires.
    stubFetch((...args: unknown[]) => {
      const init = args[1] as RequestInit;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    await expect(
      publishTenantEvent("t-1", { type: "orders.changed", entityIds: ["o-1"] }),
    ).resolves.toBeUndefined();
  }, 10_000);

  it("names the topic per tenant", () => {
    expect(tenantTopic("abc")).toBe("tenant:abc");
  });
});
