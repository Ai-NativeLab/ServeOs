import { describe, it, expect, vi } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { seedDefaultPlans } from "@/server/subscription/plans.seed";
import { startTrial } from "@/server/subscription/service";
import { auditEvents } from "@/server/audit/schema";
import { linkAccount } from "./linking";
import * as graph from "./graph";

const audit = {
  fingerprint: { deviceId: null, deviceTokenHash: null, appVersion: null, ip: null, userAgent: null },
};

async function seedTenant(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  await seedDefaultPlans();
  await startTrial(t.id, "pro");
  return t.id;
}

describe("linkAccount", () => {
  it("takes the phone number id from the Graph exchange, never from the caller", async () => {
    const tenantId = await seedTenant("wa-link-1");
    vi.spyOn(graph, "exchangeCode").mockResolvedValue({
      wabaId: "waba-real", phoneNumberId: "pn-real", displayPhoneNumber: "+201234567890", tokenRef: "env://T",
    });

    const account = await linkAccount(tenantId, { code: "oauth-code" }, audit);
    expect(account.phoneNumberId).toBe("pn-real");
    expect(account.wabaId).toBe("waba-real");
  });

  it("emits a whatsapp.account_linked audit event", async () => {
    const tenantId = await seedTenant("wa-link-2");
    vi.spyOn(graph, "exchangeCode").mockResolvedValue({
      wabaId: "w2", phoneNumberId: "pn-2", displayPhoneNumber: "+2012", tokenRef: "env://T",
    });
    await linkAccount(tenantId, { code: "c" }, audit);

    // audit_events carries FORCE RLS — read as the tenant.
    const rows = await withTenant(tenantId, (tx) => tx.select().from(auditEvents));
    expect(rows.some((r) => r.action === "whatsapp.account_linked")).toBe(true);
  });

  it("refuses a number already actively linked to another tenant", async () => {
    const t1 = await seedTenant("wa-link-3");
    const t2 = await seedTenant("wa-link-4");
    vi.spyOn(graph, "exchangeCode").mockResolvedValue({
      wabaId: "w", phoneNumberId: "pn-dup", displayPhoneNumber: "+2013", tokenRef: "env://T",
    });
    await linkAccount(t1, { code: "c" }, audit);
    await expect(linkAccount(t2, { code: "c" }, audit)).rejects.toThrow();
  });
});
