import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { Store } from "./store";

describe("Store", () => {
  it("queues and transitions outbox orders", () => {
    const s = new Store(openDb(":memory:"));
    s.enqueueOrder("c1", JSON.stringify({ lines: [] }));
    expect(s.pendingOrders().map((o) => o.client_order_id)).toEqual(["c1"]);
    s.markSynced("c1", "1042");
    expect(s.pendingOrders()).toHaveLength(0);
    expect(s.allTickets()[0].order_number).toBe("1042");
  });

  it("caches catalog", () => {
    const s = new Store(openDb(":memory:"));
    s.saveCatalog('{"categories":[]}', "2026-07-06T00:00:00Z");
    expect(s.getCatalog()?.json).toContain("categories");
  });
});
