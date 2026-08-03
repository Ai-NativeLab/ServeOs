import { describe, it, expect } from "vitest";
import { db } from "@/db/client";
import { withTenant } from "@/db/with-tenant";
import { tenants } from "@/server/tenancy/schema";
import { users, roles, userRoles } from "@/server/auth/schema";
import { branches } from "@/server/branches/schema";
import { notifications, notificationOutbox } from "./schema";
import { notify } from "./service";

async function seed(slug: string, opts: { tenantEmail?: string | null; branchEmail?: string | null } = {}) {
  const [t] = await db.insert(tenants).values({
    slug, name: "T", country: "EG", vertical: "restaurant", contactEmail: opts.tenantEmail ?? null,
  }).returning();
  const [branch] = await withTenant(t.id, (tx) => tx.insert(branches).values({
    tenantId: t.id, name: "Main", replyToEmail: opts.branchEmail ?? null,
  }).returning());

  const mkUser = async (name: string, email: string | null, roleKey: "owner" | "manager" | "staff") => {
    const [u] = await db.insert(users).values({ tenantId: t.id, name, email, status: "active" }).returning();
    const [r] = await db.insert(roles).values({ tenantId: t.id, key: roleKey, name: roleKey })
      .onConflictDoNothing().returning();
    const roleId = r?.id ?? (await withTenant(t.id, (tx) => tx.select().from(roles)))
      .find((x) => x.key === roleKey)!.id;
    await db.insert(userRoles).values({ userId: u.id, roleId });
    return u;
  };

  const owner = await mkUser("Owner", `owner-${slug}@x.com`, "owner");
  const manager = await mkUser("Manager", null, "manager"); // deliberately email-less
  return { tenantId: t.id, branchId: branch.id, owner, manager };
}

const baseEvent = {
  type: "po_sent" as const, severity: "info" as const,
  title: "PO-1 sent", body: "Purchase order PO-1 was sent to the supplier.",
};

describe("notify", () => {
  it("writes one in-app row per target — role targets stored once, not fanned out", async () => {
    const { tenantId, owner } = await seed("ntf-s1");
    await notify({ tenantId }, {
      ...baseEvent,
      targets: [{ userId: owner.id }, { role: "manager" }],
      channels: ["in_app"],
    });
    const rows = await withTenant(tenantId, (tx) => tx.select().from(notifications));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.userId === owner.id)).toBeTruthy();
    expect(rows.find((r) => r.targetRole === "manager" && r.userId === null)).toBeTruthy();
    const outbox = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(outbox).toHaveLength(0); // in_app only — nothing enqueued
  });

  it("enqueues one outbox row per resolved email recipient, skipping users without an address", async () => {
    const { tenantId, owner } = await seed("ntf-s2");
    await notify({ tenantId }, {
      ...baseEvent,
      targets: [{ role: "owner" }, { role: "manager" }], // manager has no email
      channels: ["in_app", "email"],
      emailTemplate: "po_sent",
      emailPayload: { poNumber: "PO-1" },
    });
    const outbox = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(outbox).toHaveLength(1); // just the owner
    expect(outbox[0].toEmail).toBe(owner.email);
    expect(outbox[0].template).toBe("po_sent");
    expect(outbox[0].subject).toBe("PO-1 sent");
    expect(outbox[0].payload).toEqual({ poNumber: "PO-1" });
  });

  it("resolves Reply-To branch → tenant → omitted, in that order", async () => {
    const a = await seed("ntf-s3", { branchEmail: "branch@roma.com", tenantEmail: "info@roma.com" });
    await notify({ tenantId: a.tenantId }, {
      ...baseEvent, targets: [{ role: "owner" }], channels: ["email"], branchId: a.branchId,
    });
    const [withBranch] = await withTenant(a.tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(withBranch.replyTo).toBe("branch@roma.com");

    const b = await seed("ntf-s4", { branchEmail: null, tenantEmail: "info@roma.com" });
    await notify({ tenantId: b.tenantId }, {
      ...baseEvent, targets: [{ role: "owner" }], channels: ["email"], branchId: b.branchId,
    });
    const [tenantFallback] = await withTenant(b.tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(tenantFallback.replyTo).toBe("info@roma.com");

    const c = await seed("ntf-s5");
    await notify({ tenantId: c.tenantId }, {
      ...baseEvent, targets: [{ role: "owner" }], channels: ["email"],
    });
    const [omitted] = await withTenant(c.tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(omitted.replyTo).toBeNull();
  });

  it("commits atomically with the caller's transaction — a rollback takes the rows with it", async () => {
    const { tenantId, owner } = await seed("ntf-s6");
    await expect(withTenant(tenantId, async (tx) => {
      await notify({ tenantId }, {
        ...baseEvent, targets: [{ userId: owner.id }], channels: ["in_app", "email"],
      }, tx);
      throw new Error("domain event failed after notify");
    })).rejects.toThrow(/domain event/);

    const rows = await withTenant(tenantId, (tx) => tx.select().from(notifications));
    const outbox = await withTenant(tenantId, (tx) => tx.select().from(notificationOutbox));
    expect(rows).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });
});
