import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildTenantUrl } from "./urls";

describe("buildTenantUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds localhost dev URL with http and port 3000", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    delete process.env.PORT;

    const url = buildTenantUrl("roma");
    expect(url).toBe("http://roma.serveos.localhost:3000");
  });

  it("respects custom PORT in local dev", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.localhost");
    vi.stubEnv("PORT", "4000");

    const url = buildTenantUrl("roma", "/?handoff=xyz123");
    expect(url).toBe("http://roma.serveos.localhost:4000/?handoff=xyz123");
  });

  it("builds production URL with https and no port", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");
    vi.stubEnv("PORT", "3000"); // should be ignored in production

    const url = buildTenantUrl("roma", "/?handoff=token_abc");
    expect(url).toBe("https://roma.serveos.tech/?handoff=token_abc");
  });

  it("builds QA environment URL with https and no port", () => {
    vi.stubEnv("ROOT_DOMAIN", "qa.serveos.tech");

    const url = buildTenantUrl("roma");
    expect(url).toBe("https://roma.qa.serveos.tech");
  });

  it("falls back to serveos.tech if ROOT_DOMAIN is unset in non-local environment", () => {
    delete process.env.ROOT_DOMAIN;
    vi.stubEnv("NODE_ENV", "production");

    const url = buildTenantUrl("roma");
    expect(url).toBe("https://roma.serveos.tech");
  });

  it("handles path with or without leading slash", () => {
    vi.stubEnv("ROOT_DOMAIN", "serveos.tech");

    expect(buildTenantUrl("roma", "menu")).toBe("https://roma.serveos.tech/menu");
    expect(buildTenantUrl("roma", "/menu")).toBe("https://roma.serveos.tech/menu");
  });
});
