import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { users } from "@/server/auth/schema";
import { placeOrder, transitionStatus } from "@/server/ordering/service";
import { whatsappStatusQueue } from "./schema";
import { seedWhatsappContext } from "./test-helpers";

async function actor(tenantId: string, slug: string) {
  const [u] = await db.insert(users).values({
    tenantId, name: "Staff", email: `st-${slug}@x.com`, status: "active",
  }).returning();
  return u.id;
}

const place = (tenantId: string, branchId: string, productId: string, channel: "whatsapp" | "web") =>
  placeOrder(tenantId, {
    branchId, fulfillmentType: "pickup", customerName: "Ahmed", customerPhone: "+201111111111",
    channel, lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
  });

describe("whatsapp status queue", () => {
  it("enqueues one message per announcing transition of a whatsapp order", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    const userId = await actor(tenantId, "sq1");
    const order = await place(tenantId, branchId, productId, "whatsapp");

    await transitionStatus(tenantId, order.orderId, "confirmed", userId);
    await transitionStatus(tenantId, order.orderId, "preparing", userId); // silent status
    await transitionStatus(tenantId, order.orderId, "ready", userId);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(whatsappStatusQueue));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued"]);
    expect(rows[0].waId).toBe("201012345678"); // customerPhone minus the plus
    expect(rows.map((r) => r.body).join(" ")).toMatch(/confirmed/i);
    expect(rows.map((r) => r.body).join(" ")).toMatch(/ready/i);
  });

  it("never enqueues for web or pos orders — the channel is the contract", async () => {
    const { tenantId, branchId, productId } = await seedWhatsappContext();
    const userId = await actor(tenantId, "sq2");
    const order = await place(tenantId, branchId, productId, "web");
    await transitionStatus(tenantId, order.orderId, "confirmed", userId);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(whatsappStatusQueue));
    expect(rows).toHaveLength(0);
  });
});
