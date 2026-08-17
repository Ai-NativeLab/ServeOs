import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { auditEvents } from "@/server/audit/schema";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { notifications, notificationOutbox } from "./schema";
import { notify } from "./service";
import { drainOutbox, MAX_ATTEMPTS } from "./worker";

async function seed(slug: string) {
  const [t] = await db.insert(tenants).values({ slug, name: "T", country: "EG", vertical: "restaurant" }).returning();
  const [u] = await db.insert(users).values({ tenantId: t.id, name: "O", email: `o-${slug}@x.com`, status: "active" }).returning();
  const [r] = await db.insert(roles).values({ tenantId: t.id, key: "owner", name: "owner" }).returning();
  await db.insert(userRoles).values({ userId: u.id, roleId: r.id });
  return { tenantId: t.id, email: u.email! };
}

const enqueue = (tenantId: string) =>
  notify({ tenantId }, {
    type: "po_sent", severity: "info", title: "PO-9 sent", body: "b",
    targets: [{ role: "owner" }], channels: ["email"], emailPayload: { poNumber: "PO-9" },
  });

describe("drainOutbox", () => {
  it("sends queued rows, records providerMessageId, flips to sent, and audits as system", async () => {
    const { tenantId, email } = await seed("wrk-1");
    await enqueue(tenantId);
    const p = new FakeEmailProvider();

    const res = await drainOutbox(p);
    expect(res.sent).toBe(1);
    expect(p.sent[0].to).toBe(email);

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(row.status).toBe("sent");
    expect(row.providerMessageId).toBe("fake_0");
    expect(row.sentAt).not.toBeNull();

    const audits = await withTenant(tenantId, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, "notification.email.sent")));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorType).toBe("system");
  });

  it("two concurrent drains never double-send the same row", async () => {
    const { tenantId } = await seed("wrk-2");
    await enqueue(tenantId);
    await enqueue(tenantId);
    const p = new FakeEmailProvider();

    const [a, b] = await Promise.all([drainOutbox(p), drainOutbox(p)]);
    expect(a.sent + b.sent).toBe(2);
    expect(p.sent).toHaveLength(2); // exactly two emails left the building
  });

  it("recovers a stalled 'sending' row that already has a providerMessageId WITHOUT resending", async () => {
    const { tenantId } = await seed("wrk-3");
    await enqueue(tenantId);
    // Simulate the crash window: provider accepted, DB flip never happened.
    await withTenant(tenantId, (tx) => tx.update(notificationOutbox).set({
      status: "sending", providerMessageId: "re_crashed", nextAttemptAt: new Date(Date.now() - 1000),
    }));
    const p = new FakeEmailProvider();

    const res = await drainOutbox(p);
    expect(res.sent).toBe(1);
    expect(p.sent).toHaveLength(0); // nothing re-sent

    const [row] = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(row.status).toBe("sent");
    expect(row.providerMessageId).toBe("re_crashed");
  });

  it("backs off on failure and does not retry before nextAttemptAt", async () => {
    const { tenantId } = await seed("wrk-4");
    await enqueue(tenantId);
    const p = new FakeEmailProvider();
    p.failNext = new Error("provider down");

    const first = await drainOutbox(p);
    expect(first.failed).toBe(1);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/down/);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Backoff holds: an immediate second drain must not touch the row.
    const second = await drainOutbox(p);
    expect(second.sent + second.failed).toBe(0);
    expect(p.sent).toHaveLength(0);
  });

  it("gives up after the retry budget and raises a critical owner alert", async () => {
    const { tenantId } = await seed("wrk-5");
    await enqueue(tenantId);
    await withTenant(tenantId, (tx) => tx.update(notificationOutbox).set({
      status: "failed", attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(Date.now() - 1000),
    }));
    const p = new FakeEmailProvider();
    p.failNext = new Error("still down");

    await drainOutbox(p);
    const [row] = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);

    const alerts = await withTenant(tenantId, (tx) =>
      tx.select().from(notifications).where(eq(notifications.type, "system_alert")));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].targetRole).toBe("owner");

    // Exhausted rows never come back: another drain sends nothing.
    const after = await drainOutbox(p);
    expect(after.sent + after.failed).toBe(0);
  });

  describe("payload.html passthrough", () => {
    const seedWithPayload = async (slug: string, payload: Record<string, unknown>) => {
      const { tenantId } = await seed(slug);
      await withTenant(tenantId, (tx) => tx.insert(notificationOutbox).values({
        tenantId, toEmail: "sup@x.com", subject: "PO-9", template: "po_sent", payload,
      }));
      return tenantId;
    };

    it("sends a full document from payload.html verbatim, not the key-value shell", async () => {
      const html = "<!doctype html><h1>PO-9</h1><table><tr><td>Cola</td></tr></table>";
      const tenantId = await seedWithPayload("wrk-html-1", { html });
      const p = new FakeEmailProvider();

      const res = await drainOutbox(p);
      expect(res.sent).toBe(1);
      expect(p.sent[0].to).toBe("sup@x.com");
      expect(p.sent[0].html).toBe(html);

      const [row] = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
      expect(row.status).toBe("sent");
    });

    it("still renders the key-value shell when payload.html is absent", async () => {
      await seedWithPayload("wrk-html-2", { poNumber: "PO-9" });
      const p = new FakeEmailProvider();

      await drainOutbox(p);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0].html).toContain("PO-9");
      expect(p.sent[0].html).toContain("<table");
    });

    it("ignores payload.html on any other template — the passthrough is po_sent only", async () => {
      // The passthrough is trusted because renderPurchaseOrderHtml escaped every
      // interpolation at build time. That reasoning holds for po_sent and
      // nothing else, so the guard is scoped to the template rather than to the
      // mere SHAPE of the payload — otherwise any future caller that happens to
      // set `html` turns the outbox into an arbitrary-HTML emailer.
      const { tenantId } = await seed("wrk-html-3");
      const html = "<h1>injected</h1>";
      await withTenant(tenantId, (tx) => tx.insert(notificationOutbox).values({
        tenantId, toEmail: "u@x.com", subject: "Welcome", template: "generic", payload: { html },
      }));
      const p = new FakeEmailProvider();

      await drainOutbox(p);
      expect(p.sent).toHaveLength(1);
      expect(p.sent[0].html).not.toBe(html);
      // It must come back escaped inside the key-value shell, not rendered.
      expect(p.sent[0].html).toContain("&lt;h1&gt;");
      expect(p.sent[0].html).toContain("<table");
    });
  });
});
