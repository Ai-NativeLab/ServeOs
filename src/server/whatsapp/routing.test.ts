import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { whatsappAccounts } from "./schema";
import { resolveAccount, recordInbound } from "./routing";
import type { InboundMessage } from "./payload";

async function seedAccount(slug: string, pnId: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  const [a] = await db.insert(whatsappAccounts).values({
    tenantId: t.id, wabaId: "w", phoneNumberId: pnId,
    displayPhoneNumber: "+20100", tokenRef: "env://X", status: "active",
  }).returning();
  return { tenantId: t.id, account: a };
}

const inbound = (wamid: string): InboundMessage => ({
  phoneNumberId: "pn-r1", waId: "201111111111", profileName: "A",
  providerMessageId: wamid, timestamp: 1750000000, event: { kind: "text", text: "hi" },
});

describe("routing", () => {
  it("resolves an active account and ignores a disconnected one", async () => {
    const { tenantId } = await seedAccount("wa-route-1", "pn-r1");
    expect((await resolveAccount("pn-r1"))?.tenantId).toBe(tenantId);

    await db.update(whatsappAccounts).set({ status: "disconnected" });
    expect(await resolveAccount("pn-r1")).toBeNull();
  });

  it("records an inbound message once and reports a replay as already seen", async () => {
    const { tenantId, account } = await seedAccount("wa-route-2", "pn-r1");
    const m = inbound("wamid.dedup.1");

    const first = await withTenant(tenantId, (tx) => recordInbound(account, m, tx));
    expect(first).toBe(true);

    // Meta retries for up to 7 days; the same wamid must not be processed twice.
    const second = await withTenant(tenantId, (tx) => recordInbound(account, m, tx));
    expect(second).toBe(false);
  });
});
