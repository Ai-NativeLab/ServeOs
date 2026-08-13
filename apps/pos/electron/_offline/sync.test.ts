import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { Store, type AuthUser } from "./store";
import { SyncEngine, type PosApiClient, type SyncEvent, type SyncResult, type SyncStatus } from "./sync";

function makeStore(): Store {
  return new Store(openDb(":memory:"));
}

function networkError(msg = "fetch failed"): Error {
  return Object.assign(new Error(msg), { isNetwork: true });
}

function domainError(msg: string): Error {
  return Object.assign(new Error(msg), { isNetwork: false });
}

const applied = (e: SyncEvent): SyncResult => ({ eventId: e.eventId, status: "applied", result: { id: e.eventId } });
const duplicate = (e: SyncEvent): SyncResult => ({ eventId: e.eventId, status: "duplicate", result: { id: e.eventId } });
const refused = (e: SyncEvent, code: string, message: string): SyncResult => ({
  eventId: e.eventId, status: "failed", error: { code, message },
});

const ROSTER: AuthUser[] = [
  { userId: "u1", name: "Cashier", email: "c@x.com", passwordHash: "salt:hash", permissions: ["pos:sell"] },
];

/**
 * Records every batch exactly as it went over the wire, so the assertions can
 * be about what the server would actually receive — envelope fields, seq
 * order, batch boundaries — rather than about the engine agreeing with itself.
 */
class FakeApi implements PosApiClient {
  batches: SyncEvent[][] = [];
  pings = 0;
  catalogPulls = 0;
  rosterPulls = 0;
  reachable = true;
  respond: (events: SyncEvent[]) => Promise<SyncResult[]> = async (events) => events.map(applied);

  async ping(): Promise<void> {
    this.pings += 1;
    if (!this.reachable) throw networkError();
  }

  async getCatalog() {
    this.catalogPulls += 1;
    if (!this.reachable) throw networkError();
    return { menu: { categories: [] }, pricing: { vatEnabled: true, vatRate: 14 }, catalogVersion: 7, syncedAt: "2026-08-14T00:00:00.000Z" };
  }

  async getAuthRoster() {
    this.rosterPulls += 1;
    if (!this.reachable) throw networkError();
    return { users: ROSTER, syncedAt: "2026-08-14T00:00:00.000Z" };
  }

  async postEvents(events: SyncEvent[]): Promise<SyncResult[]> {
    this.batches.push(events);
    if (!this.reachable) throw networkError();
    return this.respond(events);
  }
}

/** A sale as PosMain appends it: envelope fields live in the payload until the
 *  engine lifts them out. */
function appendSale(store: Store, clientOrderId: string, extra: Record<string, unknown> = {}): string {
  return store.appendEvent("sale.recorded", {
    actorUserId: "11111111-1111-4111-8111-111111111111",
    clientOrderId,
    clientShiftId: "cs1",
    lines: [{ productId: "p1", quantity: 1, selectedOptionIds: [] }],
    lineSnapshots: [{ productId: "p1", productNameEn: "Tea", productNameAr: "شاي", unitPrice: 10, quantity: 1, lineTotal: 10 }],
    expectedTotal: 10,
    payments: [{ clientPaymentId: `${clientOrderId}-0`, method: "cash", amount: 10 }],
    ...extra,
  }).eventId;
}

describe("SyncEngine.flush", () => {
  it("flushes strictly in seq order and resumes after a network cut mid-batch", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    appendSale(store, "o2");
    appendSale(store, "o3");

    let call = 0;
    api.respond = async (events) => {
      call += 1;
      if (call === 2) throw networkError();
      return events.map(applied);
    };

    const engine = new SyncEngine(store, api, { batchSize: 2 });
    await engine.flush();

    expect(api.batches[0].map((e) => e.seq)).toEqual([1, 2]);
    expect(api.batches[1].map((e) => e.seq)).toEqual([3]);
    expect(store.pendingEvents().map((e) => e.seq)).toEqual([3]);
    expect(engine.status().state).toBe("offline");

    // The cut is over: the next flush picks up exactly where it stopped.
    api.respond = async (events) => events.map(applied);
    await engine.flush();

    expect(api.batches[2].map((e) => e.seq)).toEqual([3]);
    expect(store.pendingEvents()).toHaveLength(0);
    expect(engine.status()).toMatchObject({ state: "online", pending: 0 });
  });

  it("sends the envelope the server validates: seq, occurredAt, actorUserId and authorizedByUserId lifted off the payload", async () => {
    const store = makeStore();
    const api = new FakeApi();
    store.appendEvent("cash.movement", {
      actorUserId: "11111111-1111-4111-8111-111111111111",
      authorizedByUserId: "22222222-2222-4222-8222-222222222222",
      type: "pay_out",
      amount: 500,
      reasonCode: "supplier",
    });

    await new SyncEngine(store, api).flush();

    const [sent] = api.batches[0];
    expect(sent).toMatchObject({
      seq: 1,
      type: "cash.movement",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      authorizedByUserId: "22222222-2222-4222-8222-222222222222",
    });
    expect(typeof sent.occurredAt).toBe("string");
    // The payload the per-type validator sees carries no envelope fields.
    expect(sent.payload).toEqual({ type: "pay_out", amount: 500, reasonCode: "supplier" });
  });

  it("halts on a domain rejection and leaves later events pending", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    appendSale(store, "o2");
    appendSale(store, "o3");

    // The server stops at its first failure and answers nothing for the rest.
    api.respond = async (events) => [applied(events[0]), refused(events[1], "no_open_shift", "no drawer is open")];

    const engine = new SyncEngine(store, api, { batchSize: 3 });
    await engine.flush();

    const status = engine.status();
    expect(status.state).toBe("halted");
    expect(status.haltedOn).toMatchObject({ type: "sale.recorded", error: "no_open_shift: no drawer is open" });
    // Event 2 is failed, event 3 untouched and still owed.
    expect(store.pendingEvents().map((e) => e.seq)).toEqual([3]);
    expect(store.hasFailedEvents()).toBe(true);
  });

  it("the halt is STICKY: after a rejection, subsequent ticks send NOTHING until the failed event is resolved", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    appendSale(store, "o2");
    api.respond = async (events) => [refused(events[0], "forbidden", "a manager must approve this")];

    const engine = new SyncEngine(store, api);
    await engine.flush();
    expect(api.batches).toHaveLength(1);

    // More work piles up behind the halt; still nothing goes out.
    appendSale(store, "o3");
    await engine.flush();
    await engine.tick();

    expect(api.batches).toHaveLength(1);
    expect(engine.status().state).toBe("halted");
    expect(engine.status().pending).toBe(2);
  });

  it("retryFailed (failed → pending) lets the next flush resume from that seq", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    appendSale(store, "o2");
    appendSale(store, "o3");
    api.respond = async (events) => [applied(events[0]), refused(events[1], "forbidden", "needs a manager")];

    const engine = new SyncEngine(store, api);
    await engine.flush();
    expect(engine.status().state).toBe("halted");

    api.respond = async (events) => events.map(applied);
    await engine.retryFailed();

    // Resumes at the failed seq — not after it — and drains the rest.
    expect(api.batches[1].map((e) => e.seq)).toEqual([2, 3]);
    expect(store.pendingEvents()).toHaveLength(0);
    expect(store.hasFailedEvents()).toBe(false);
    expect(engine.status()).toMatchObject({ state: "online", pending: 0 });
  });

  it("comes back up halted after a restart, without re-sending anything", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    api.respond = async (events) => [refused(events[0], "unknown_actor", "no such user")];
    await new SyncEngine(store, api).flush();

    // A fresh engine over the same store — the failed row is what carries the halt.
    const restarted = new SyncEngine(store, api);
    expect(restarted.status().state).toBe("halted");
    expect(restarted.status().haltedOn).toMatchObject({ error: "unknown_actor: no such user" });
    await restarted.flush();
    expect(api.batches).toHaveLength(1);
  });

  it("only one flush runs at a time — overlapping triggers coalesce (single-flight)", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    api.respond = async (events) => {
      await gate;
      return events.map(applied);
    };

    const engine = new SyncEngine(store, api);
    const a = engine.flush();
    const b = engine.flush();
    release();
    await Promise.all([a, b]);

    expect(api.batches).toHaveLength(1);
    expect(store.pendingEvents()).toHaveLength(0);
  });

  it("a flush after reconnect replays duplicates safely (server says duplicate → mark synced)", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    appendSale(store, "o2");
    api.respond = async (events) => events.map(duplicate);

    const engine = new SyncEngine(store, api);
    await engine.flush();

    expect(store.pendingEvents()).toHaveLength(0);
    expect(store.hasFailedEvents()).toBe(false);
    expect(engine.status().state).toBe("online");
  });

  it("reports each accepted event to onApplied, in seq order, so the caller can advance its snapshot", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    appendSale(store, "o2");
    const seen: number[] = [];

    await new SyncEngine(store, api, { onApplied: (row) => seen.push(row.seq) }).flush();

    expect(seen).toEqual([1, 2]);
  });

  it("a batch-level refusal (not one event's) neither halts nor loses the queue", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    api.respond = async () => { throw domainError("HTTP 401: Unauthorized"); };

    const engine = new SyncEngine(store, api);
    await engine.flush();

    expect(engine.status().state).not.toBe("halted");
    expect(store.hasFailedEvents()).toBe(false);
    expect(store.pendingEvents()).toHaveLength(1);
    expect(engine.status().lastError).toContain("401");
  });
});

describe("SyncEngine.tick", () => {
  it("ping failure flips state to offline; success flips back and triggers flush + pull", async () => {
    const store = makeStore();
    const api = new FakeApi();
    appendSale(store, "o1");
    api.reachable = false;

    const engine = new SyncEngine(store, api);
    const seen: SyncStatus[] = [];
    engine.onState((s) => seen.push(s));

    await engine.tick();
    expect(engine.status().state).toBe("offline");
    expect(engine.isOnline()).toBe(false);
    expect(api.catalogPulls).toBe(0);
    expect(api.batches).toHaveLength(0);

    api.reachable = true;
    await engine.tick();

    // The offline→online edge pulls the catalog (with pricing + version) and
    // the roster, then drains the queue.
    expect(api.catalogPulls).toBe(1);
    expect(store.getCatalog()).toMatchObject({ catalogVersion: 7 });
    expect(JSON.parse(store.getCatalog()!.pricingJson!)).toMatchObject({ vatRate: 14 });
    expect(store.findAuthUser("c@x.com")).toMatchObject({ userId: "u1" });
    expect(api.batches).toHaveLength(1);
    expect(engine.status().state).toBe("online");
    expect(seen.map((s) => s.state)).toContain("offline");
  });

  it("refreshes the roster on every online tick, but re-pulls the catalog only on the reconnect edge", async () => {
    const store = makeStore();
    const api = new FakeApi();
    const engine = new SyncEngine(store, api);

    await engine.tick();
    await engine.tick();

    expect(api.catalogPulls).toBe(1);
    expect(api.rosterPulls).toBe(2);
  });

  it("keeps ticking when the roster is refused — it is cashier-gated and nobody may be signed in", async () => {
    const store = makeStore();
    const api = new FakeApi();
    api.getAuthRoster = async () => { throw domainError("HTTP 401: Unauthorized"); };
    appendSale(store, "o1");

    const engine = new SyncEngine(store, api);
    await engine.tick();

    expect(engine.status().state).toBe("online");
    expect(store.pendingEvents()).toHaveLength(0);
  });
});
