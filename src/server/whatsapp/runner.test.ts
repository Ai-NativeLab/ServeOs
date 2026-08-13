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

/**
 * Taps only what the previous message actually offered.
 *
 * The walks below synthesise tap ids directly, which is convenient but hides a
 * whole class of bug: a state can be unreachable because nothing ever RENDERS
 * the button that leads to it. That is exactly what happened here — a
 * first-time customer had no way into the catalogue at all, because `start` was
 * only emitted in the returning-customer branch, and every text path replied
 * with an instruction to send a word that just reset the conversation.
 */
function lastOfferedIds(p: FakeWhatsAppProvider): string[] {
  const msg = p.sent[p.sent.length - 1]?.msg as
    | { kind: "buttons"; buttons: { id: string }[] }
    | { kind: "list"; rows: { id: string }[] }
    | { kind: "text" }
    | undefined;
  if (!msg) return [];
  if (msg.kind === "buttons") return msg.buttons.map((b) => b.id);
  if (msg.kind === "list") return msg.rows.map((r) => r.id);
  return [];
}

describe("a first-time customer can reach the catalogue using only what is offered", () => {
  it("gets a tappable way in from a plain greeting", async () => {
    const { account } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();

    await handleInbound(account, inboundText("menu"), p);

    const offered = lastOfferedIds(p);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some((id) => id.startsWith("start:"))).toBe(true);
  });

  it("is not told to repeat a word that only restarts the conversation", async () => {
    const { account } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();

    // Any opening text at all — greeting, restart word, or something random.
    for (const text of ["hello", "menu", "pizza"]) {
      await handleInbound(account, inboundText(text), p);
      expect(lastOfferedIds(p).length).toBeGreaterThan(0);
    }
  });

  it("reaches the category list by tapping only rendered ids", async () => {
    const { account } = await seedWhatsappContext();
    const p = new FakeWhatsAppProvider();

    await handleInbound(account, inboundText("hi"), p);
    const start = lastOfferedIds(p).find((id) => id.startsWith("start:"));
    expect(start).toBeDefined();

    const [action, , payload] = start!.split(":");
    await handleInbound(account, await inboundTap(account.tenantId, WA, action, payload), p);

    // A single-branch tenant skips branch selection and lands on categories.
    const rows = lastOfferedIds(p);
    expect(rows.some((id) => id.startsWith("cat:"))).toBe(true);
  });
});

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
