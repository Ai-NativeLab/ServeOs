import { describe, it, expect } from "vitest";
import { pruneRecentOrders, type RecentOrder } from "./recent-orders";

const now = new Date("2026-07-07T12:00:00Z");
const entry = (over: Partial<RecentOrder>): RecentOrder => ({
  token: "t", orderNumber: 1, placedAt: "2026-07-07T11:00:00Z", ...over,
});

describe("pruneRecentOrders", () => {
  it("drops terminal statuses", () => {
    const list = [entry({ status: "completed" }), entry({ token: "u", status: "pending" })];
    expect(pruneRecentOrders(list, now).map((e) => e.token)).toEqual(["u"]);
  });
  it("drops entries older than 24h", () => {
    const list = [entry({ placedAt: "2026-07-06T11:00:00Z" }), entry({ token: "u" })];
    expect(pruneRecentOrders(list, now).map((e) => e.token)).toEqual(["u"]);
  });
  it("keeps at most the 3 newest", () => {
    const list = [1, 2, 3, 4].map((n) =>
      entry({ token: `t${n}`, orderNumber: n, placedAt: `2026-07-07T0${n}:00:00Z` }));
    expect(pruneRecentOrders(list, now).map((e) => e.orderNumber)).toEqual([4, 3, 2]);
  });
});
