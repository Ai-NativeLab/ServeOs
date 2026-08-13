import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "./db";
import { Store, type AuthUser } from "./store";

function makeStore(): Store {
  return new Store(openDb(":memory:"));
}

/** Some assertions need to inspect raw columns (server_response JSON) that
 *  the Store API deliberately doesn't expose a getter for — this opens the
 *  same connection two ways rather than reaching into Store's private db. */
function makeStoreWithDb(): { store: Store; db: Database.Database } {
  const db = openDb(":memory:");
  return { store: new Store(db), db };
}

describe("Store — order outbox (pre-existing)", () => {
  it("queues and transitions outbox orders", () => {
    const s = makeStore();
    s.enqueueOrder("c1", JSON.stringify({ lines: [] }));
    expect(s.pendingOrders().map((o) => o.client_order_id)).toEqual(["c1"]);
    s.markSynced("c1", "1042");
    expect(s.pendingOrders()).toHaveLength(0);
    expect(s.allTickets()[0].order_number).toBe("1042");
  });

  it("marks an outbox order failed with its error", () => {
    const s = makeStore();
    s.enqueueOrder("c1", JSON.stringify({ lines: [] }));
    s.markFailed("c1", "boom");
    expect(s.pendingOrders()).toHaveLength(0);
    expect(s.allTickets()[0]).toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("Store — device pairing (pre-existing)", () => {
  it("saves, reads, and clears the paired device", () => {
    const s = makeStore();
    expect(s.getDevice()).toBeNull();
    s.saveDevice({ token: "t1", tenantId: "ten1", branchId: "br1", branchName: "Main" });
    expect(s.getDevice()).toMatchObject({ token: "t1", tenant_id: "ten1" });
    s.clearDevice();
    expect(s.getDevice()).toBeNull();
  });
});

describe("Store — catalog cache (gains pricing + version, Task 8)", () => {
  it("round-trips json, pricing, and catalog version", () => {
    const s = makeStore();
    s.saveCatalog('{"categories":[]}', '{"vatEnabled":true}', 7, "2026-08-13T00:00:00Z");
    const cached = s.getCatalog();
    expect(cached?.json).toContain("categories");
    expect(cached?.pricingJson).toContain("vatEnabled");
    expect(cached?.catalogVersion).toBe(7);
    expect(cached?.syncedAt).toBe("2026-08-13T00:00:00Z");
  });

  it("a second save overwrites the single row, not appends", () => {
    const s = makeStore();
    s.saveCatalog("a", "p1", 1, "t1");
    s.saveCatalog("b", "p2", 2, "t2");
    expect(s.getCatalog()).toMatchObject({ json: "b", pricingJson: "p2", catalogVersion: 2, syncedAt: "t2" });
  });
});

describe("Store — local_events (Task 8)", () => {
  it("appendEvent assigns strictly increasing, gap-free seq", () => {
    const s = makeStore();
    const a = s.appendEvent("shift.opened", { clientShiftId: "cs1" });
    const b = s.appendEvent("cash.movement", { type: "pay_in", amount: 10 });
    const c = s.appendEvent("shift.closed", {});
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(new Set([a.eventId, b.eventId, c.eventId]).size).toBe(3);
  });

  it("pendingEvents respects seq order regardless of insertion trickery", () => {
    const s = makeStore();
    const first = s.appendEvent("shift.opened", { n: 1 });
    const second = s.appendEvent("cash.movement", { n: 2 });
    const rows = s.pendingEvents();
    expect(rows.map((r) => r.event_id)).toEqual([first.eventId, second.eventId]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("synced events are excluded from pendingEvents", () => {
    const s = makeStore();
    const a = s.appendEvent("shift.opened", { n: 1 });
    const b = s.appendEvent("cash.movement", { n: 2 });
    s.markEventSynced(a.eventId, { applied: true });
    const rows = s.pendingEvents();
    expect(rows.map((r) => r.event_id)).toEqual([b.eventId]);
    const synced = s.pendingEvents(); // still excluded on a second read
    expect(synced.map((r) => r.event_id)).toEqual([b.eventId]);
  });

  it("failed events are excluded from pendingEvents too", () => {
    const s = makeStore();
    const a = s.appendEvent("cash.movement", { n: 1 });
    s.markEventFailed(a.eventId, "forbidden");
    expect(s.pendingEvents()).toHaveLength(0);
  });

  it("hasFailedEvents is true after a markEventFailed and false after retry", () => {
    const s = makeStore();
    const a = s.appendEvent("cash.movement", { n: 1 });
    expect(s.hasFailedEvents()).toBe(false);
    s.markEventFailed(a.eventId, "forbidden");
    expect(s.hasFailedEvents()).toBe(true);
    s.retryFailedEvent(a.eventId);
    expect(s.hasFailedEvents()).toBe(false);
  });

  it("retryFailedEvent moves the event back to pending, in its original seq position", () => {
    const s = makeStore();
    const a = s.appendEvent("shift.opened", { n: 1 });
    const b = s.appendEvent("cash.movement", { n: 2 });
    s.markEventFailed(a.eventId, "forbidden");
    s.retryFailedEvent(a.eventId);
    expect(s.pendingEvents().map((r) => r.event_id)).toEqual([a.eventId, b.eventId]);
  });

  it("retryFailedEvent is a no-op on an event that is not failed", () => {
    const s = makeStore();
    const a = s.appendEvent("shift.opened", { n: 1 });
    s.markEventSynced(a.eventId, { ok: true });
    s.retryFailedEvent(a.eventId); // synced, not failed — must not resurrect it
    expect(s.pendingEvents()).toHaveLength(0);
  });

  it("markEventSynced stores the server response", () => {
    const { store: s, db } = makeStoreWithDb();
    const a = s.appendEvent("shift.opened", { n: 1 });
    s.markEventSynced(a.eventId, { shiftId: "srv-1" });
    const raw = db
      .prepare("SELECT status, server_response FROM local_events WHERE event_id = ?")
      .get(a.eventId) as { status: string; server_response: string };
    expect(raw.status).toBe("synced");
    expect(JSON.parse(raw.server_response)).toEqual({ shiftId: "srv-1" });
  });
});

describe("Store — auth_cache roster (Task 8)", () => {
  const alice: AuthUser = {
    userId: "u1",
    name: "Alice",
    email: "alice@example.com",
    passwordHash: "salt:hash1",
    permissions: ["pos:sell"],
  };
  const bob: AuthUser = {
    userId: "u2",
    name: "Bob",
    email: "bob@example.com",
    passwordHash: "salt:hash2",
    permissions: ["pos:sell", "reconciliation:manage"],
  };

  it("findAuthUser looks up by email, permissions round-trip", () => {
    const s = makeStore();
    s.saveAuthRoster([alice, bob], "2026-08-13T00:00:00Z");
    expect(s.findAuthUser("bob@example.com")).toEqual(bob);
    expect(s.findAuthUser("nobody@example.com")).toBeNull();
  });

  it("saveAuthRoster replace-all removes departed users", () => {
    const s = makeStore();
    s.saveAuthRoster([alice, bob], "t1");
    expect(s.findAuthUser("bob@example.com")).not.toBeNull();

    s.saveAuthRoster([alice], "t2"); // bob left the tenant / was deactivated
    expect(s.findAuthUser("bob@example.com")).toBeNull();
    expect(s.findAuthUser("alice@example.com")).not.toBeNull();
  });

  it("saveAuthRoster with an empty roster clears the cache", () => {
    const s = makeStore();
    s.saveAuthRoster([alice], "t1");
    s.saveAuthRoster([], "t2");
    expect(s.findAuthUser("alice@example.com")).toBeNull();
  });
});

describe("Store — local_state (Task 8)", () => {
  it("getState is null until set, then round-trips arbitrary JSON", () => {
    const s = makeStore();
    expect(s.getState("tillState")).toBeNull();
    s.setState("tillState", { salesCount: 3 });
    expect(s.getState<{ salesCount: number }>("tillState")).toEqual({ salesCount: 3 });
  });

  it("setState overwrites the same key rather than erroring", () => {
    const s = makeStore();
    s.setState("k", { v: 1 });
    s.setState("k", { v: 2 });
    expect(s.getState("k")).toEqual({ v: 2 });
  });

  it("distinct keys do not collide", () => {
    const s = makeStore();
    s.setState("a", 1);
    s.setState("b", 2);
    expect(s.getState("a")).toBe(1);
    expect(s.getState("b")).toBe(2);
  });
});
