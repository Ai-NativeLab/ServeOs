import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The cron gate, and only the cron gate: `drainEtaSubmissions` has its own
 * exhaustive suite (`server/fiscal/worker.test.ts`) and is faked here so this
 * file tests the one thing the route adds — that an unauthenticated caller
 * cannot make the deployment talk to ETA.
 */
vi.mock("@/server/fiscal/worker", () => ({
  drainEtaSubmissions: vi.fn(async () => ({
    processed: 1, submitted: 1, accepted: 0, rejected: 0, failed: 0, deferred: 0, reconciled: 0, skippedTenants: 0,
  })),
}));

import { GET } from "./route";
import { drainEtaSubmissions } from "@/server/fiscal/worker";

const req = (auth?: string) =>
  new NextRequest("http://localhost/api/fiscal/worker", {
    headers: auth ? { authorization: auth } : {},
  });

const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  vi.mocked(drainEtaSubmissions).mockClear();
  process.env.CRON_SECRET = "cron-secret-value";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("GET /api/fiscal/worker", () => {
  it("drains on Vercel's bearer token", async () => {
    const res = await GET(req("Bearer cron-secret-value"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fiscal: expect.objectContaining({ processed: 1 }) });
    expect(drainEtaSubmissions).toHaveBeenCalledTimes(1);
  });

  it("401s a missing, wrong or unprefixed token without touching ETA", async () => {
    for (const auth of [undefined, "cron-secret-value", "Bearer wrong", "Bearer "]) {
      const res = await GET(req(auth));
      expect(res.status).toBe(401);
    }
    expect(drainEtaSubmissions).not.toHaveBeenCalled();
  });

  it("401s when CRON_SECRET is unset — an unconfigured deployment is closed, not open", async () => {
    delete process.env.CRON_SECRET;
    // Without this branch, `Bearer undefined` would match an absent header
    // comparison and leave the endpoint world-callable.
    expect((await GET(req("Bearer undefined"))).status).toBe(401);
    expect((await GET(req())).status).toBe(401);
    expect(drainEtaSubmissions).not.toHaveBeenCalled();
  });
});
