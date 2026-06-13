import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { tenants } from "./schema";
import { resolveTenantByHost, createTenant } from "./service";

describe("tenancy service", () => {
  it("creates a tenant with defaults", async () => {
    const t = await createTenant({ slug: "roma", name: "Roma", country: "EG" });
    expect(t.slug).toBe("roma");
    expect(t.status).toBe("onboarding");
  });

  it("derives SAR currency and Riyadh timezone for SA tenants", async () => {
    const t = await createTenant({ slug: "riyadh-bites", name: "Riyadh Bites", country: "SA" });
    expect(t.currency).toBe("SAR");
    expect(t.timezone).toBe("Asia/Riyadh");
  });

  it("resolves a tenant from a storefront host", async () => {
    await db.insert(tenants).values({ slug: "roma", name: "Roma", country: "EG", status: "active" });
    const t = await resolveTenantByHost("roma.serveos.localhost", "serveos.localhost");
    expect(t?.slug).toBe("roma");
  });

  it("returns null for the bare root domain and app/admin hosts", async () => {
    expect(await resolveTenantByHost("serveos.localhost", "serveos.localhost")).toBeNull();
    expect(await resolveTenantByHost("app.serveos.localhost", "serveos.localhost")).toBeNull();
    expect(await resolveTenantByHost("admin.serveos.localhost", "serveos.localhost")).toBeNull();
  });

  it("derived currency/timezone win over caller-supplied values", async () => {
    const t = await createTenant({ slug: "eg-co", name: "EG Co", country: "EG", currency: "USD", timezone: "America/New_York" } as any);
    expect(t.currency).toBe("EGP");
    expect(t.timezone).toBe("Africa/Cairo");
  });

  it("subdomainFromHost returns null for reserved and multi-label hosts and is case-insensitive", async () => {
    const { subdomainFromHost } = await import("./service");
    expect(subdomainFromHost("api.serveos.localhost", "serveos.localhost")).toBeNull();
    expect(subdomainFromHost("www.serveos.localhost", "serveos.localhost")).toBeNull();
    expect(subdomainFromHost("a.b.serveos.localhost", "serveos.localhost")).toBeNull();
    expect(subdomainFromHost("ROMA.serveos.localhost", "serveos.localhost")).toBe("roma");
  });
});
