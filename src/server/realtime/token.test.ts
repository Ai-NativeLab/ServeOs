import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { mintTenantRealtimeToken, tenantRealtimeConfig } from "./token";

const SECRET = "jwt-secret-from-the-supabase-project";

function decode(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [h, c] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(c, "base64url").toString("utf8")),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("mintTenantRealtimeToken", () => {
  it("signs a tenant-scoped HS256 token the project secret verifies", () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", SECRET);
    const minted = mintTenantRealtimeToken("tenant-a", 1_700_000_000_000)!;

    const [h, c, signature] = minted.token.split(".");
    expect(createHmac("sha256", SECRET).update(`${h}.${c}`).digest("base64url")).toBe(signature);

    const { header, claims } = decode(minted.token);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(claims).toMatchObject({ role: "authenticated", tenant_id: "tenant-a", aud: "authenticated" });
    expect(claims.exp).toBeGreaterThan(claims.iat as number);
    expect(minted.expiresAt).toBe(new Date((claims.exp as number) * 1000).toISOString());
  });

  it("scopes each token to one tenant — the claim is the only thing that grants a topic", () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", SECRET);
    const a = decode(mintTenantRealtimeToken("tenant-a")!.token).claims;
    const b = decode(mintTenantRealtimeToken("tenant-b")!.token).claims;
    expect(a.tenant_id).toBe("tenant-a");
    expect(b.tenant_id).toBe("tenant-b");
  });

  it("mints nothing without the project's JWT secret", () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", "");
    expect(mintTenantRealtimeToken("tenant-a")).toBeNull();
  });
});

describe("tenantRealtimeConfig", () => {
  it("hands the subscriber the topic and its token", () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");

    const cfg = tenantRealtimeConfig("tenant-a")!;
    expect(cfg.url).toBe("https://proj.supabase.co");
    expect(cfg.anonKey).toBe("anon-key");
    expect(cfg.topic).toBe("tenant:tenant-a");
    expect(decode(cfg.token).claims.tenant_id).toBe("tenant-a");
  });

  it("is null when any half of the config is missing — subscribers then stay on polling", () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", SECRET);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    expect(tenantRealtimeConfig("tenant-a")).toBeNull();

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.co");
    vi.stubEnv("SUPABASE_JWT_SECRET", "");
    expect(tenantRealtimeConfig("tenant-a")).toBeNull();
  });
});
