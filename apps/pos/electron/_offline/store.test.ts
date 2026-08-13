import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { openDb, type AtRestCipher } from "./db";
import { Store, type AuthUser } from "./store";

function makeStore(): Store {
  return new Store(openDb(":memory:"));
}

/** Some assertions need to inspect raw columns (server_response JSON, or a
 *  plaintext-vs-ciphertext row) that the Store API deliberately doesn't
 *  expose a getter for — this opens the same connection two ways rather than
 *  reaching into Store's private db. `cipher` defaults to none, same as
 *  `makeStore`. */
function makeStoreWithDb(cipher?: AtRestCipher): { store: Store; db: Database.Database } {
  const db = openDb(":memory:");
  return { store: cipher ? new Store(db, cipher) : new Store(db), db };
}

/** A deterministic, reversible stand-in for safeStorage: proves Store calls
 *  through to whatever cipher it's given, without needing Electron. Ciphertext
 *  is trivially distinguishable from plaintext, which is exactly what the
 *  round-trip assertions below need. */
function fakeCipher(available: boolean): AtRestCipher {
  return {
    isAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC(${s})`, "utf8"),
    decryptString: (b) => {
      const s = b.toString("utf8");
      const m = /^ENC\((.*)\)$/s.exec(s);
      if (!m) throw new Error("fakeCipher: not its own ciphertext");
      return m[1];
    },
  };
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
    s.saveCatalog('{"categories":[]}', '{"vatEnabled":true}', '{"payoutThreshold":0}', 7, "2026-08-13T00:00:00Z");
    const cached = s.getCatalog();
    expect(cached?.json).toContain("categories");
    expect(cached?.pricingJson).toContain("vatEnabled");
    expect(cached?.shiftPolicyJson).toContain("payoutThreshold");
    expect(cached?.catalogVersion).toBe(7);
    expect(cached?.syncedAt).toBe("2026-08-13T00:00:00Z");
  });

  it("a second save overwrites the single row, not appends", () => {
    const s = makeStore();
    s.saveCatalog("a", "p1", "sp1", 1, "t1");
    s.saveCatalog("b", "p2", "sp2", 2, "t2");
    expect(s.getCatalog()).toMatchObject({ json: "b", pricingJson: "p2", shiftPolicyJson: "sp2", catalogVersion: 2, syncedAt: "t2" });
  });

  it("shiftPolicyJson is null until the first catalog pull writes it (Part B fold-in)", () => {
    const s = makeStore();
    expect(s.getCatalog()).toBeNull();
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

  it("unsyncedEvents keeps failed events (their effect happened at the till) but drops synced ones", () => {
    const s = makeStore();
    const a = s.appendEvent("shift.opened", { n: 1 });
    const b = s.appendEvent("sale.recorded", { n: 2 });
    const c = s.appendEvent("cash.movement", { n: 3 });
    s.markEventSynced(a.eventId, { ok: true });
    s.markEventFailed(b.eventId, "forbidden");
    // The confirmed snapshot has absorbed `a` and nothing else, so boot must
    // replay exactly b and c on top of it — in seq order.
    expect(s.unsyncedEvents().map((r) => r.event_id)).toEqual([b.eventId, c.eventId]);
  });

  it("appendEvent reports the occurred_at it stamped, so a caller can project the event without re-reading it", () => {
    const s = makeStore();
    const { eventId, occurredAt } = s.appendEvent("shift.opened", { n: 1 });
    expect(s.pendingEvents().find((r) => r.event_id === eventId)?.occurred_at).toBe(occurredAt);
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

  it("markEventSynced runs onCommit inside the same transaction as the status update (Task 14 fold-in)", () => {
    const { store: s, db } = makeStoreWithDb();
    const a = s.appendEvent("shift.opened", { n: 1 });

    s.markEventSynced(a.eventId, { ok: true }, () => s.setState("till_state", { snapshotOf: a.eventId }));

    const row = db.prepare("SELECT status FROM local_events WHERE event_id = ?").get(a.eventId) as { status: string };
    expect(row.status).toBe("synced");
    expect(s.getState("till_state")).toEqual({ snapshotOf: a.eventId });
  });

  it("markEventSynced rolls back the status update when onCommit throws — the event stays pending for the next flush", () => {
    const s = makeStore();
    const a = s.appendEvent("shift.opened", { n: 1 });

    expect(() =>
      s.markEventSynced(a.eventId, { ok: true }, () => {
        throw new Error("snapshot write failed");
      }),
    ).toThrow("snapshot write failed");

    // Not "synced" (rolled back) and not "failed" either — the send simply
    // never happened as far as the log is concerned, so it goes out again.
    expect(s.pendingEvents().map((r) => r.event_id)).toEqual([a.eventId]);
    expect(s.hasFailedEvents()).toBe(false);
  });
});

describe("Store — local_events retention (Task 14)", () => {
  it("deletes a synced event once it falls outside the 30-day window", () => {
    const { store: s, db } = makeStoreWithDb();
    const a = s.appendEvent("shift.opened", { n: 1 });
    s.markEventSynced(a.eventId, { ok: true });
    const in31Days = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);

    expect(s.pruneSyncedEvents(in31Days)).toBe(1);
    expect(db.prepare("SELECT 1 FROM local_events WHERE event_id = ?").get(a.eventId)).toBeUndefined();
  });

  it("leaves a synced event inside the window untouched", () => {
    const s = makeStore();
    const a = s.appendEvent("shift.opened", { n: 1 });
    s.markEventSynced(a.eventId, { ok: true });

    expect(s.pruneSyncedEvents(new Date())).toBe(0);
    expect(s.getState("anything")).toBeNull(); // sanity: db still usable
  });

  it("never prunes pending or failed rows, no matter how old — only status='synced' is eligible", () => {
    const s = makeStore();
    const pending = s.appendEvent("cash.movement", { n: 1 });
    const failed = s.appendEvent("cash.movement", { n: 2 });
    s.markEventFailed(failed.eventId, "boom");
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    expect(s.pruneSyncedEvents(farFuture)).toBe(0);
    expect(s.pendingEvents().map((r) => r.event_id)).toEqual([pending.eventId]);
    expect(s.hasFailedEvents()).toBe(true);
  });
});

describe("Store — at-rest encryption (Task 14)", () => {
  const alice: AuthUser = {
    userId: "u1",
    name: "Alice",
    email: "alice@example.com",
    passwordHash: "salt:hash1",
    permissions: ["pos:sell"],
  };

  it("encrypts auth_cache.password_hash when a cipher is available, and findAuthUser decrypts it back transparently", () => {
    const { store: s, db } = makeStoreWithDb(fakeCipher(true));
    s.saveAuthRoster([alice], "t1");

    const raw = db.prepare("SELECT password_hash FROM auth_cache WHERE user_id = ?").get("u1") as { password_hash: string };
    expect(raw.password_hash).not.toBe(alice.passwordHash);
    expect(raw.password_hash.startsWith("enc:v1:")).toBe(true);
    expect(s.findAuthUser("alice@example.com")?.passwordHash).toBe(alice.passwordHash);
  });

  it("stores plaintext when the cipher reports unavailable — same degrade as no cipher at all", () => {
    const { store: s, db } = makeStoreWithDb(fakeCipher(false));
    s.saveAuthRoster([alice], "t1");

    const raw = db.prepare("SELECT password_hash FROM auth_cache WHERE user_id = ?").get("u1") as { password_hash: string };
    expect(raw.password_hash).toBe(alice.passwordHash);
    expect(s.findAuthUser("alice@example.com")?.passwordHash).toBe(alice.passwordHash);
  });

  it("still reads a plaintext row written before encryption was available, once a cipher is wired up later", () => {
    const db = openDb(":memory:");
    new Store(db).saveAuthRoster([alice], "t1"); // no cipher — an existing dev install's plaintext row

    const upgraded = new Store(db, fakeCipher(true)); // same file, reopened with encryption now on
    expect(upgraded.findAuthUser("alice@example.com")?.passwordHash).toBe(alice.passwordHash);
  });

  it("encrypts catalog_cache.json when a cipher is available, and getCatalog decrypts it back transparently", () => {
    const { store: s, db } = makeStoreWithDb(fakeCipher(true));
    s.saveCatalog('{"categories":["secret menu"]}', "p1", "sp1", 1, "t1");

    const raw = db.prepare("SELECT json FROM catalog_cache WHERE id = 1").get() as { json: string };
    expect(raw.json).not.toContain("secret menu");
    expect(s.getCatalog()?.json).toContain("secret menu");
  });

  it("still reads a plaintext catalog_cache.json written before encryption was available", () => {
    const db = openDb(":memory:");
    new Store(db).saveCatalog('{"categories":[]}', "p1", "sp1", 1, "t1");

    const upgraded = new Store(db, fakeCipher(true));
    expect(upgraded.getCatalog()?.json).toBe('{"categories":[]}');
  });

  it("never encrypts pricing_json or shift_policy_json — only json is in scope", () => {
    const { store: s, db } = makeStoreWithDb(fakeCipher(true));
    s.saveCatalog("{}", '{"vatEnabled":true}', '{"payoutThreshold":500}', 1, "t1");

    const raw = db
      .prepare("SELECT pricing_json AS pricingJson, shift_policy_json AS shiftPolicyJson FROM catalog_cache WHERE id = 1")
      .get() as { pricingJson: string; shiftPolicyJson: string };
    expect(raw.pricingJson).toBe('{"vatEnabled":true}');
    expect(raw.shiftPolicyJson).toBe('{"payoutThreshold":500}');
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
