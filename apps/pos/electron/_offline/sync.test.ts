// PARKED — excluded in vitest.config.ts. Tests the old order_outbox +
// postOrder SyncEngine (sync.ts), which Task 10 (SyncEngine v2, plan
// docs/moai/plans/2026-08-09-pos-offline-sync.md) rewrites against the
// local_events log Task 8 added. Do not delete; un-exclude once sync.ts is
// rewritten and this file is updated to match the new engine's API.
import { describe, it, expect, vi } from "vitest";
import { openDb } from "./db";
import { Store } from "./store";
import { SyncEngine } from "./sync";

function makeStore() { return new Store(openDb(":memory:")); }

describe("SyncEngine.flush", () => {
  it("marks an order synced on success", async () => {
    const store = makeStore();
    store.enqueueOrder("c1", JSON.stringify({ lines: [] }));
    const api = { getCatalog: vi.fn(), postOrder: vi.fn().mockResolvedValue({ orderId: "o1", orderNumber: "7" }) };
    const engine = new SyncEngine(store, api as never, () => {});
    await engine.flush();
    expect(store.pendingOrders()).toHaveLength(0);
    expect(store.allTickets()[0].order_number).toBe("7");
  });

  it("keeps order pending on network failure", async () => {
    const store = makeStore();
    store.enqueueOrder("c2", JSON.stringify({ lines: [] }));
    const api = { getCatalog: vi.fn(), postOrder: vi.fn().mockRejectedValue(Object.assign(new Error("offline"), { isNetwork: true })) };
    const engine = new SyncEngine(store, api as never, () => {});
    await engine.flush();
    expect(store.pendingOrders()).toHaveLength(1);
  });
});
