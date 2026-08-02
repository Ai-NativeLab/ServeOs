import { describe, it, expect } from "vitest";
import { withTenant } from "@/db/with-tenant";
import { orders } from "@/server/ordering/schema";
import { auditEvents } from "@/server/audit/schema";
import { whatsappConversations, whatsappOrderReceipts } from "./schema";
import { FakeWhatsAppProvider } from "./fake-provider";
import { handleInbound } from "./runner";
import { seedWhatsappContext, inboundText, inboundTap } from "./test-helpers";

const WA = "201111111111";

/** The full pickup walk: start → category → product → checkout → pickup → name. */
async function walkToConfirm(
  account: Awaited<ReturnType<typeof seedWhatsappContext>>["account"],
  tenantId: string, categoryId: string, productId: string, p: FakeWhatsAppProvider,
) {
  await handleInbound(account, inboundText("menu"), p);                         // welcome (idle)
  await handleInbound(account, await inboundTap(tenantId, WA, "start", "go"), p);   // idle -> (single branch) categories
  await handleInbound(account, await inboundTap(tenantId, WA, "cat", categoryId), p);
  await handleInbound(account, await inboundTap(tenantId, WA, "add", productId), p);
  await handleInbound(account, await inboundTap(tenantId, WA, "checkout", "x"), p);
  await handleInbound(account, await inboundTap(tenantId, WA, "ful", "pickup"), p);
  await handleInbound(account, await inboundTap(tenantId, WA, "name", "profile"), p);
}

describe("handleInbound", () => {
  it("walks a full pickup order into the orders table on the whatsapp channel", async () => {
    const { account, tenantId, categoryId, productId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();

    await walkToConfirm(account, tenantId, categoryId, productId, p);
    await handleInbound(account, await inboundTap(tenantId, WA, "confirm", "yes"), p);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(orders));
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("whatsapp");
    expect(rows[0].customerName).toBe("Ahmed");
    expect(rows[0].fulfillmentType).toBe("pickup");
  });

  it("does not place a second order when Meta replays the confirm tap", async () => {
    const { account, tenantId, categoryId, productId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();
    await walkToConfirm(account, tenantId, categoryId, productId, p);

    const confirm = await inboundTap(tenantId, WA, "confirm", "yes");
    await handleInbound(account, confirm, p);
    // Same wamid, same tap — Meta's redelivery. The receipt reservation absorbs it.
    await handleInbound(account, confirm, p);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(orders));
    expect(rows).toHaveLength(1);
    const receipts = await withTenant(tenantId, (tx) => tx.select().from(whatsappOrderReceipts));
    expect(receipts).toHaveLength(1);
  });

  it("bumps stateVersion on every transition so stale taps are rejected", async () => {
    const { account, tenantId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();
    await handleInbound(account, inboundText("menu"), p);
    const [c1] = await withTenant(tenantId, (tx) => tx.select().from(whatsappConversations));
    await handleInbound(account, await inboundTap(tenantId, WA, "start", "go"), p);
    const [c2] = await withTenant(tenantId, (tx) => tx.select().from(whatsappConversations));
    expect(c2.stateVersion).toBeGreaterThan(c1.stateVersion);
  });

  it("emits a whatsapp.order_placed audit event", async () => {
    const { account, tenantId, categoryId, productId } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();
    await walkToConfirm(account, tenantId, categoryId, productId, p);
    await handleInbound(account, await inboundTap(tenantId, WA, "confirm", "yes"), p);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(auditEvents));
    expect(rows.some((r) => r.action === "whatsapp.order_placed")).toBe(true);
  });
});
