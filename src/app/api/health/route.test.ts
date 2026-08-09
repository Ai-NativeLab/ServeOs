import { describe, it, expect, afterEach } from "vitest";
import { GET } from "./route";

// vi.stubEnv can't delete a var on older vitest majors; save/restore by hand.
const ORIGINAL_SHA = process.env.VERCEL_GIT_COMMIT_SHA;
afterEach(() => {
  if (ORIGINAL_SHA === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = ORIGINAL_SHA;
});

describe("GET /api/health", () => {
  it("returns ok plus the commit sha Vercel baked into the build", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abc1234";
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sha: "abc1234" });
  });

  it("falls back to 'dev' when no sha is present (local dev)", async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    const res = GET();
    expect(await res.json()).toEqual({ ok: true, sha: "dev" });
  });
});
