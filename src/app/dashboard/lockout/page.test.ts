import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import type { ReactElement } from "react";
import type { Tenant } from "@/server/tenancy/schema";

/**
 * #187 review: the lockout screen trusted `?status=` over the tenant's live
 * status, so a stale or hand-edited link showed the wrong reason — and an
 * active tenant who landed here (bookmark, reactivation mid-session) was stuck
 * on a lockout card instead of being sent back into the dashboard.
 */
const redirectMock = vi.fn((path: string) => {
  const err = new Error(`NEXT_REDIRECT: ${path}`) as Error & { digest: string };
  err.digest = `NEXT_REDIRECT;replace;${path};307;;`;
  throw err;
});
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirectMock(path) }));

const requireDashboardUserMock = vi.fn();
vi.mock("@/server/auth/dashboard-context", () => ({
  requireDashboardUser: (...args: unknown[]) => requireDashboardUserMock(...args),
}));
vi.mock("@/app/dashboard/actions", () => ({ signOutAction: async () => {} }));

import LockoutPage from "./page";

const asTenant = (status: Tenant["status"]) => ({
  tenant: { id: "t-1", name: "Roma Cafe", status } as unknown as Tenant,
});

beforeEach(() => {
  redirectMock.mockClear();
  requireDashboardUserMock.mockReset();
});

describe("lockout page", () => {
  it("shows the tenant's live status, whatever the query string says", async () => {
    requireDashboardUserMock.mockResolvedValue(asTenant("suspended"));

    const html = renderToString((await LockoutPage({ searchParams: Promise.resolve({ status: "onboarding" }) })) as ReactElement);

    expect(html).toContain("Account Suspended");
    expect(html).not.toContain("Application Under Review");
  });

  it("sends an active or trial tenant back to the dashboard", async () => {
    for (const status of ["active", "trial"] as const) {
      requireDashboardUserMock.mockResolvedValue(asTenant(status));
      await expect(LockoutPage({ searchParams: Promise.resolve({ status: "suspended" }) })).rejects.toThrow(/NEXT_REDIRECT/);
      expect(redirectMock).toHaveBeenLastCalledWith("/dashboard");
    }
  });
});
