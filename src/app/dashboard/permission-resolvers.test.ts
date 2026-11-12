import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DashboardContext } from "@/server/auth/dashboard-context";

/**
 * #187 review: the #172 change made the page wrappers redirect to the denial
 * screen, and the API-route resolvers below were built on those wrappers — so
 * a missing permission surfaced as a NEXT_REDIRECT that the "no session"
 * check caught, and every inventory/purchasing API answered a staff user 401
 * instead of 403. An API caller needs the status it can act on.
 */
const redirectMock = vi.fn((path: string) => {
  const err = new Error(`NEXT_REDIRECT: ${path}`) as Error & { digest: string };
  err.digest = `NEXT_REDIRECT;replace;${path};307;;`;
  throw err;
});
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirectMock(path) }));

const requireDashboardUserMock = vi.fn();
vi.mock("@/server/auth/dashboard-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth/dashboard-context")>()),
  requireDashboardUser: () => requireDashboardUserMock(),
}));

import { resolveInventoryContext } from "./inventory-permission";
import { resolvePurchasingContext } from "./purchasing-permission";

const staff = { user: { id: "u-1" }, tenantId: "t-1", tenant: {}, roleKeys: ["staff"] } as unknown as DashboardContext;
const owner = { ...staff, roleKeys: ["owner"] } as unknown as DashboardContext;

beforeEach(() => {
  redirectMock.mockClear();
  requireDashboardUserMock.mockReset();
});

describe("API permission resolvers", () => {
  it("answer 403 — not 401, not a redirect — when the permission is missing", async () => {
    requireDashboardUserMock.mockResolvedValue(staff);

    const inv = await resolveInventoryContext("inventory:manage");
    expect(inv.denied?.status).toBe(403);

    const pur = await resolvePurchasingContext("purchasing:manage");
    expect(pur.denied?.status).toBe(403);

    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("still answer 401 when there is no session", async () => {
    requireDashboardUserMock.mockImplementation(async () => redirectMock("/login"));

    expect((await resolveInventoryContext("inventory:view")).denied?.status).toBe(401);
  });

  it("resolve the context when the permission is held", async () => {
    requireDashboardUserMock.mockResolvedValue(owner);

    expect((await resolveInventoryContext("inventory:manage")).ctx).toBe(owner);
    expect((await resolvePurchasingContext("purchasing:manage")).ctx).toBe(owner);
  });
});
