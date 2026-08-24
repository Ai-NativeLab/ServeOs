import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";
import * as auth from "@/server/auth/dashboard-context";

describe("POST /api/media-upload", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 401 when user is unauthenticated", async () => {
    vi.spyOn(auth, "requireDashboardUser").mockRejectedValue(new Error("Unauthorized"));

    const req = new NextRequest("http://localhost:3000/api/media-upload", {
      method: "POST",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 501 naming missing config when storage env vars are absent", async () => {
    vi.spyOn(auth, "requireDashboardUser").mockResolvedValue({
      user: { id: "u1", email: "user@test.com" } as any,
      tenantId: "t1",
      roleKeys: ["owner"],
    });

    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const file = new File(["fake-image-content"], "test.png", { type: "image/png" });
    const form = new FormData();
    form.set("type", "product");
    form.set("file", file);

    const req = new NextRequest("http://localhost:3000/api/media-upload", {
      method: "POST",
      body: form,
    });

    const res = await POST(req);
    expect(res.status).toBe(501);

    const body = await res.json();
    expect(body.error).toContain("Image storage is not configured");
    expect(body.error).toContain("SUPABASE_URL");
    expect(body.error).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("identifies specifically which env var is missing", async () => {
    vi.spyOn(auth, "requireDashboardUser").mockResolvedValue({
      user: { id: "u1", email: "user@test.com" } as any,
      tenantId: "t1",
      roleKeys: ["owner"],
    });

    vi.stubEnv("SUPABASE_URL", "https://xyz.supabase.co");
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const file = new File(["fake-image-content"], "test.png", { type: "image/png" });
    const form = new FormData();
    form.set("type", "product");
    form.set("file", file);

    const req = new NextRequest("http://localhost:3000/api/media-upload", {
      method: "POST",
      body: form,
    });

    const res = await POST(req);
    expect(res.status).toBe(501);

    const body = await res.json();
    expect(body.error).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(body.error).not.toContain("SUPABASE_URL,");
  });
});
