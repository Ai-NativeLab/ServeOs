import { describe, it, expect } from "vitest";
import { loadEnv } from "@/env";

describe("loadEnv", () => {
  it("returns DATABASE_URL when present", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.DATABASE_URL).toBe("postgres://x");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it("uses provided ROOT_DOMAIN", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x", ROOT_DOMAIN: "app.example.com" });
    expect(env.ROOT_DOMAIN).toBe("app.example.com");
  });

  it("defaults ROOT_DOMAIN to serveos.localhost when absent", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://x" });
    expect(env.ROOT_DOMAIN).toBe("serveos.localhost");
  });
});
