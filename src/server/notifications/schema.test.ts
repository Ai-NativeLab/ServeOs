import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { notifications, notificationOutbox, emailEvents } from "./schema";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  return t.id;
}

describe("notifications schema", () => {
  it("is invisible outside its tenant (FORCE RLS)", async () => {
    const a = await seed("ntf-a");
    const b = await seed("ntf-b");
    await withTenant(a, (tx) => tx.insert(notifications).values({
      tenantId: a, targetRole: "owner", type: "system_alert", severity: "critical",
      title: "Chain broken", body: "x",
    }));
    const seen = await withTenant(b, (tx) => tx.select().from(notifications));
    expect(seen).toHaveLength(0);
    const own = await withTenant(a, (tx) => tx.select().from(notifications));
    expect(own).toHaveLength(1);
    expect(own[0].readAt).toBeNull();
  });

  it("refuses a row that targets neither a user nor a role", async () => {
    const t = await seed("ntf-c");
    await expect(
      withTenant(t, (tx) => tx.insert(notifications).values({
        tenantId: t, type: "system_alert", severity: "info", title: "t", body: "b",
      })),
    ).rejects.toThrow();
  });

  it("outbox rows default to queued with zero attempts and are RLS-scoped", async () => {
    const a = await seed("ntf-d");
    const b = await seed("ntf-e");
    const [row] = await withTenant(a, (tx) => tx.insert(notificationOutbox).values({
      tenantId: a, toEmail: "supplier@x.com", subject: "PO-1",
      template: "po_sent", payload: { poNumber: "PO-1" },
    }).returning());
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    const seen = await withTenant(b, (tx) => tx.select().from(notificationOutbox));
    expect(seen).toHaveLength(0);
  });

  it("email_events dedupes on (provider, providerEventId)", async () => {
    await db.insert(emailEvents).values({
      provider: "resend", providerMessageId: "m1", providerEventId: "ev1",
      eventType: "delivered", raw: {},
    });
    const second = await db.insert(emailEvents).values({
      provider: "resend", providerMessageId: "m1", providerEventId: "ev1",
      eventType: "delivered", raw: {},
    }).onConflictDoNothing().returning();
    expect(second).toHaveLength(0);
  });
});
