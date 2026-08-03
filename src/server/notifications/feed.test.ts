import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users } from "@/server/auth/schema";
import { notifications, notificationOutbox } from "./schema";
import { notify, listNotifications, markNotificationsRead } from "./service";
import { recordEmailEvent } from "./email-events";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  const [me] = await db.insert(users).values({ tenantId: t.id, name: "Me", email: `me-${slug}@x.com`, status: "active" }).returning();
  const [other] = await db.insert(users).values({ tenantId: t.id, name: "Other", email: `ot-${slug}@x.com`, status: "active" }).returning();
  return { tenantId: t.id, me, other };
}

describe("notification feed", () => {
  it("shows own + role-broadcast rows, never another user's", async () => {
    const { tenantId, me, other } = await seed("feed-1");
    await notify({ tenantId }, { type: "refund_issued", severity: "info", title: "mine", body: "b", targets: [{ userId: me.id }], channels: ["in_app"] });
    await notify({ tenantId }, { type: "shift_variance", severity: "warning", title: "managers", body: "b", targets: [{ role: "manager" }], channels: ["in_app"] });
    await notify({ tenantId }, { type: "refund_issued", severity: "info", title: "theirs", body: "b", targets: [{ userId: other.id }], channels: ["in_app"] });

    const feed = await listNotifications(tenantId, me.id, ["manager"]);
    expect(feed.notifications.map((n) => n.title).sort()).toEqual(["managers", "mine"]);
    expect(feed.unreadCount).toBe(2);
  });

  it("mark-read is scoped to visible rows and idempotent; omitted ids mark all", async () => {
    const { tenantId, me, other } = await seed("feed-2");
    await notify({ tenantId }, { type: "refund_issued", severity: "info", title: "mine", body: "b", targets: [{ userId: me.id }], channels: ["in_app"] });
    await notify({ tenantId }, { type: "refund_issued", severity: "info", title: "theirs", body: "b", targets: [{ userId: other.id }], channels: ["in_app"] });

    await markNotificationsRead(tenantId, me.id, []);
    await markNotificationsRead(tenantId, me.id, []); // idempotent

    expect((await listNotifications(tenantId, me.id, [])).unreadCount).toBe(0);
    // The other user's row was never touched.
    expect((await listNotifications(tenantId, other.id, [])).unreadCount).toBe(1);
  });

  it("filters by unread and severity", async () => {
    const { tenantId, me } = await seed("feed-3");
    await notify({ tenantId }, { type: "system_alert", severity: "critical", title: "c", body: "b", targets: [{ userId: me.id }], channels: ["in_app"] });
    await notify({ tenantId }, { type: "refund_issued", severity: "info", title: "i", body: "b", targets: [{ userId: me.id }], channels: ["in_app"] });

    const critical = await listNotifications(tenantId, me.id, [], { severity: "critical" });
    expect(critical.notifications.map((n) => n.title)).toEqual(["c"]);
  });
});

describe("recordEmailEvent", () => {
  const evt = (over: Partial<Parameters<typeof recordEmailEvent>[0]> = {}) => ({
    provider: "resend", providerMessageId: "re_msg_1", providerEventId: `ev-${Math.random()}`,
    eventType: "delivered" as const, raw: {}, ...over,
  });

  it("dedupes on (provider, providerEventId)", async () => {
    const e = evt({ providerEventId: "ev-dup" });
    expect(await recordEmailEvent(e)).toEqual({ duplicate: false });
    expect(await recordEmailEvent(e)).toEqual({ duplicate: true });
  });

  it("a bounce marks the outbox row and raises a critical owner alert", async () => {
    const { tenantId } = await seed("feed-4");
    const [row] = await withTenant(tenantId, (tx) => tx.insert(notificationOutbox).values({
      tenantId, toEmail: "dead@supplier.com", subject: "PO-7", template: "po_sent",
      payload: {}, status: "sent", providerMessageId: "re_bounce_1",
    }).returning());

    await recordEmailEvent(evt({ providerMessageId: "re_bounce_1", eventType: "bounced" }));

    const [after] = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(after.id).toBe(row.id);
    expect(after.lastError).toMatch(/bounced/);

    const alerts = await withTenant(tenantId, (tx) => tx.select().from(notifications));
    expect(alerts.some((n) => n.severity === "critical" && n.targetRole === "owner")).toBe(true);
  });
});
