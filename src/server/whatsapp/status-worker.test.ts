import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { auditEvents } from "@/server/audit/schema";
import { placeOrder, transitionStatus } from "@/server/ordering/service";
import { whatsappStatusQueue, whatsappConversations, whatsappMessages, whatsappAccounts } from "./schema";
import { FakeWhatsAppProvider } from "./fake-provider";
import { drainWhatsappStatus } from "./status-worker";
import { seedWhatsappContext } from "./test-helpers";

const WA = "201111111111";

async function seedQueuedStatus(opts: { lastInboundAgoMs?: number | null } = {}) {
  const seeded = await seedWhatsappContext();
  const { tenantId, branchId, productId } = seeded;
  const [u] = await db.insert(users).values({ tenantId, name: "S", email: `s-${tenantId.slice(0, 6)}@x.com`, status: "active" }).returning();

  if (opts.lastInboundAgoMs !== null) {
    await withTenant(tenantId, (tx) => tx.insert(whatsappConversations).values({
      tenantId, waId: WA, state: "placed", cart: [],
      lastInboundAt: new Date(Date.now() - (opts.lastInboundAgoMs ?? 60_000)),
    }));
  }

  const order = await placeOrder(tenantId, {
    branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: `+${WA}`,
    channel: "whatsapp", lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
  });
  await transitionStatus(tenantId, order.orderId, "confirmed", u.id);
  return { ...seeded, orderId: order.orderId };
}

describe("drainWhatsappStatus", () => {
  it("sends inside the 24h window, records the wamid, logs the outbound message, audits as system", async () => {
    const { tenantId } = await seedQueuedStatus({ lastInboundAgoMs: 60_000 });
    const p = new FakeWhatsAppProvider();

    const res = await drainWhatsappStatus(p);
    expect(res.sent).toBe(1);
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0].waId).toBe(WA);
    expect(JSON.stringify(p.sent[0].msg)).toMatch(/confirmed/i);

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(whatsappStatusQueue));
    expect(row.status).toBe("sent");
    expect(row.wamid).toMatch(/^wamid\.fake/);

    const logged = await withTenant(tenantId, (tx) =>
      tx.select().from(whatsappMessages).where(eq(whatsappMessages.direction, "outbound")));
    expect(logged).toHaveLength(1);
    expect(logged[0].providerMessageId).toBe(row.wamid);

    const audits = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "whatsapp.status_sent")));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorType).toBe("system");
  });

  it("skips as template_required outside the 24h window — no free sends, no pretending", async () => {
    const { tenantId } = await seedQueuedStatus({ lastInboundAgoMs: 25 * 60 * 60 * 1000 });
    const p = new FakeWhatsAppProvider();

    const res = await drainWhatsappStatus(p);
    expect(res.skipped).toBe(1);
    expect(p.sent).toHaveLength(0);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(whatsappStatusQueue));
    expect(row.status).toBe("skipped");
    expect(row.skipReason).toBe("template_required");
  });

  it("skips as account_unlinked when the tenant's number is disconnected", async () => {
    const { tenantId } = await seedQueuedStatus({ lastInboundAgoMs: 60_000 });
    await db.update(whatsappAccounts).set({ status: "disconnected" })
      .where(eq(whatsappAccounts.tenantId, tenantId));
    const p = new FakeWhatsAppProvider();

    const res = await drainWhatsappStatus(p);
    expect(res.skipped).toBe(1);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(whatsappStatusQueue));
    expect(row.skipReason).toBe("account_unlinked");
  });

  it("backs off on provider failure and does not retry before nextAttemptAt", async () => {
    const { tenantId } = await seedQueuedStatus({ lastInboundAgoMs: 60_000 });
    const p = new FakeWhatsAppProvider();
    // FakeWhatsAppProvider has no failNext; force a rejection via a wrapper.
    const failing = {
      send: async () => { throw new Error("cloud api down"); },
    };

    const first = await drainWhatsappStatus(failing);
    expect(first.failed).toBe(1);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(whatsappStatusQueue));
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    const second = await drainWhatsappStatus(p);
    expect(second.sent + second.failed).toBe(0); // backoff holds
  });
});
