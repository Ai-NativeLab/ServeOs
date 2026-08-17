import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

afterEach(() => vi.unstubAllEnvs());

function run(host: string, extraHeaders: Record<string, string> = {}) {
  return proxy(
    new NextRequest(`http://${host}/api/health`, {
      headers: { host, ...extraHeaders },
    }),
  );
}

// NextResponse.next() encodes its verdict in response headers:
//   x-middleware-rewrite      → present only when a rewrite happened
//   x-middleware-request-*    → the request headers passed to the route
//   x-middleware-override-headers → the full list of forwarded header keys
describe("proxy() passes /api/health through unrewritten", () => {
  it.each([
    ["serveos.tech", "marketing"], // prod apex
    ["www.serveos.tech", "marketing"], // prod www
    ["ghost.serveos.tech", "storefront"], // unknown tenant still passes through
  ])("%s → surface %s, no rewrite", (host, surface) => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");
    const res = run(host);
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-surface")).toBe(surface);
  });

  it("qa apex (ROOT_DOMAIN=qa.serveos.tech) → marketing, no rewrite", () => {
    vi.stubEnv("ROOT_DOMAIN", "qa.serveos.tech");
    const res = run("qa.serveos.tech");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-surface")).toBe("marketing");
  });

  it("sets the tenant slug for a storefront host", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");
    const res = run("roma.serveos.tech");
    expect(res.headers.get("x-middleware-request-x-surface")).toBe("storefront");
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("roma");
  });

  it("strips a spoofed x-tenant-slug on non-storefront hosts", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");
    const res = run("www.serveos.tech", { "x-tenant-slug": "evil" });
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBeNull();
    expect(res.headers.get("x-middleware-override-headers")).not.toContain(
      "x-tenant-slug",
    );
  });
});

function marketingRequest(host: string, path: string) {
  return new NextRequest(new URL(`http://${host}${path}`), { headers: { host } });
}

describe("proxy locale handling on the marketing surface", () => {
  it("rewrites / to /ar and stamps the Arabic locale", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    const res = proxy(marketingRequest("serveos.localhost", "/"));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/ar");
    expect(res.headers.get("x-middleware-request-x-locale")).toBe("ar");
  });

  it("passes /en through with the English locale", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    const res = proxy(marketingRequest("serveos.localhost", "/en"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-locale")).toBe("en");
  });

  it("redirects /ar to the canonical root", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    const res = proxy(marketingRequest("serveos.localhost", "/ar"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://serveos.localhost/");
  });

  it("leaves the storefront surface untouched", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    const res = proxy(marketingRequest("roma.serveos.localhost", "/"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-locale")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-tenant-slug")).toBe("roma");
  });

  it("leaves /login on the marketing host untouched", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    const res = proxy(marketingRequest("serveos.localhost", "/login"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-locale")).toBeNull();
  });

  it("still passes /api/health through on the marketing host", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    const res = proxy(marketingRequest("serveos.localhost", "/api/health"));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-locale")).toBeNull();
  });
});
