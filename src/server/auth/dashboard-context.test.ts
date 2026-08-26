import { describe, it, expect, vi, beforeEach } from "vitest";
import { requireDashboardUser } from "./dashboard-context";
import type { Tenant } from "@/server/tenancy/schema";


const mockRedirect = vi.fn((path: string) => {
  const err = new Error(`NEXT_REDIRECT: ${path}`) as Error & { digest: string };
  err.digest = `NEXT_REDIRECT;replace;${path};307;;`;
  throw err;
});

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

const mockCookiesGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: mockCookiesGet,
  }),
}));

vi.mock("./session", () => ({
  validateSession: vi.fn(),
}));

vi.mock("./current-user", () => ({
  SESSION_COOKIE: "serveos_session",
  loadUserRoleKeys: vi.fn().mockResolvedValue(["owner"]),
}));

vi.mock("@/server/tenancy", () => ({
  getTenantById: vi.fn(),
}));

import { validateSession } from "./session";
import { getTenantById } from "@/server/tenancy";

describe("requireDashboardUser - tenant status lockout (Issue #164)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCookiesGet.mockReturnValue({ value: "valid-session-token" });
    vi.mocked(validateSession).mockResolvedValue({
      user: {
        id: "user-1",
        email: "owner@roma.com",
        name: "Owner",
        tenantId: "tenant-1",
        platformRole: null,
      },
    } as unknown as Awaited<ReturnType<typeof validateSession>>);
  });

  it("permits active tenant users to access dashboard", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      id: "tenant-1",
      slug: "roma",
      name: "Roma Cafe",
      status: "active",
    } as unknown as Awaited<ReturnType<typeof validateSession>>);

    const ctx = await requireDashboardUser();
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.tenantId).toBe("tenant-1");
    expect(ctx.tenant.status).toBe("active");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("permits trial tenant users to access dashboard", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      id: "tenant-1",
      slug: "roma",
      name: "Roma Cafe",
      status: "trial",
    } as unknown as Awaited<ReturnType<typeof validateSession>>);

    const ctx = await requireDashboardUser();
    expect(ctx.tenant.status).toBe("trial");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects suspended tenant users to lockout screen", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      id: "tenant-1",
      slug: "roma",
      name: "Roma Cafe",
      status: "suspended" } as Tenant);

    await expect(requireDashboardUser()).rejects.toThrow(/NEXT_REDIRECT.*lockout/);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("lockout"));
  });

  it("allows a suspended tenant through only on the recovery path (allowSuspended)", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      id: "tenant-1",
      slug: "roma",
      name: "Roma Cafe",
      status: "suspended" } as Tenant);

    const ctx = await requireDashboardUser({ allowSuspended: true });
    expect(ctx.tenant.status).toBe("suspended");
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects rejected tenant users to lockout screen", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      id: "tenant-1",
      slug: "roma",
      name: "Roma Cafe",
      status: "rejected" } as Tenant);

    await expect(requireDashboardUser()).rejects.toThrow(/NEXT_REDIRECT.*lockout/);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("lockout"));
  });

  it("redirects onboarding tenant users to pending approval / lockout screen", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      id: "tenant-1",
      slug: "roma",
      name: "Roma Cafe",
      status: "onboarding" } as Tenant);

    await expect(requireDashboardUser()).rejects.toThrow(/NEXT_REDIRECT.*lockout/);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("lockout"));
  });

  it("allows lockout page to load context without redirecting itself", async () => {
    vi.mocked(getTenantById).mockResolvedValue({
      id: "tenant-1",
      slug: "roma",
      name: "Roma Cafe",
      status: "suspended" } as Tenant);

    const ctx = await requireDashboardUser({ allowStatus: ["suspended", "rejected", "onboarding"] });
    expect(ctx.tenant.status).toBe("suspended");
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
