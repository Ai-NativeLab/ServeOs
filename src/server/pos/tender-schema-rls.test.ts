import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { branches } from "@/server/branches/schema";
import { users } from "@/server/auth/schema";
import { orders } from "@/server/ordering/schema";
import { orderPayments, posAdjustmentEvents, posHeldTickets } from "./tender-schema";
import { posDevices } from "./schema";

async function makeTenantOrder(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG" }).returning();
  const [branch] = await withTenant(t.id, (tx) => tx.insert(branches).values({ tenantId: t.id, name: "Main" }).returning());
  const [user] = await withTenant(t.id, (tx) => tx.insert(users).values({ tenantId: t.id, name: "Cashier" }).returning());
  const [order] = await withTenant(t.id, (tx) =>
    tx.insert(orders).values({
      tenantId: t.id,
      branchId: branch.id,
      orderNumber: 1,
      fulfillmentType: "pickup",
      customerName: "C",
      customerPhone: "1",
      subtotal: "100",
      vatRateSnapshot: "0.14",
      vatAmount: "14",
      total: "114",
      statusToken: `${slug}-token`,
    }).returning(),
  );
  return { tenant: t, branch, user, order };
}

describe("pos tender-schema RLS isolation", () => {
  it("order_payments: withTenant(A) cannot see tenant B's payment rows", async () => {
    const a = await makeTenantOrder("tender-rls-a");
    const b = await makeTenantOrder("tender-rls-b");

    await withTenant(a.tenant.id, (tx) =>
      tx.insert(orderPayments).values({
        tenantId: a.tenant.id,
        orderId: a.order.id,
        method: "cash",
        amount: "114",
        takenByUserId: a.user.id,
        clientPaymentId: "a-1",
      }),
    );
    await withTenant(b.tenant.id, (tx) =>
      tx.insert(orderPayments).values({
        tenantId: b.tenant.id,
        orderId: b.order.id,
        method: "cash",
        amount: "114",
        takenByUserId: b.user.id,
        clientPaymentId: "b-1",
      }),
    );

    const seenByA = await withTenant(a.tenant.id, (tx) => tx.select().from(orderPayments));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].tenantId).toBe(a.tenant.id);

    const seenByB = await withTenant(b.tenant.id, (tx) => tx.select().from(orderPayments));
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0].tenantId).toBe(b.tenant.id);

    const bare = await db.select().from(orderPayments);
    expect(bare).toHaveLength(0); // FORCE RLS fails closed without app.tenant_id
  });

  it("pos_adjustment_events: isolates rows per tenant and fails closed outside withTenant", async () => {
    const a = await makeTenantOrder("tender-rls-adj-a");
    const b = await makeTenantOrder("tender-rls-adj-b");

    await withTenant(a.tenant.id, (tx) =>
      tx.insert(posAdjustmentEvents).values({
        tenantId: a.tenant.id,
        orderId: a.order.id,
        type: "order_discount",
        amount: "10",
        reasonCode: "manager_comp",
        byUserId: a.user.id,
        authorizedByUserId: a.user.id,
      }),
    );
    await withTenant(b.tenant.id, (tx) =>
      tx.insert(posAdjustmentEvents).values({
        tenantId: b.tenant.id,
        orderId: b.order.id,
        type: "order_discount",
        amount: "10",
        reasonCode: "manager_comp",
        byUserId: b.user.id,
        authorizedByUserId: b.user.id,
      }),
    );

    const seenByA = await withTenant(a.tenant.id, (tx) => tx.select().from(posAdjustmentEvents));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].tenantId).toBe(a.tenant.id);

    const bare = await db.select().from(posAdjustmentEvents);
    expect(bare).toHaveLength(0);
  });

  it("pos_held_tickets: isolates rows per tenant and fails closed outside withTenant", async () => {
    const a = await makeTenantOrder("tender-rls-hold-a");
    const b = await makeTenantOrder("tender-rls-hold-b");
    const [deviceA] = await withTenant(a.tenant.id, (tx) =>
      tx.insert(posDevices).values({ tenantId: a.tenant.id, branchId: a.branch.id, token: "tok-a", label: "Till 1", createdByUserId: a.user.id }).returning(),
    );
    const [deviceB] = await withTenant(b.tenant.id, (tx) =>
      tx.insert(posDevices).values({ tenantId: b.tenant.id, branchId: b.branch.id, token: "tok-b", label: "Till 1", createdByUserId: b.user.id }).returning(),
    );

    await withTenant(a.tenant.id, (tx) =>
      tx.insert(posHeldTickets).values({
        tenantId: a.tenant.id,
        branchId: a.branch.id,
        deviceId: deviceA.id,
        cashierUserId: a.user.id,
        label: "Ticket 1",
        draftJson: {},
      }),
    );
    await withTenant(b.tenant.id, (tx) =>
      tx.insert(posHeldTickets).values({
        tenantId: b.tenant.id,
        branchId: b.branch.id,
        deviceId: deviceB.id,
        cashierUserId: b.user.id,
        label: "Ticket 1",
        draftJson: {},
      }),
    );

    const seenByA = await withTenant(a.tenant.id, (tx) => tx.select().from(posHeldTickets));
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0].tenantId).toBe(a.tenant.id);

    const bare = await db.select().from(posHeldTickets);
    expect(bare).toHaveLength(0);
  });
});
