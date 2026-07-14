import { describe, it, expect } from "vitest";
import { orderStatusMeta } from "./order-status";

describe("orderStatusMeta", () => {
  it("maps known statuses to a label and brand badge class", () => {
    expect(orderStatusMeta("pending").label).toBe("Pending");
    expect(orderStatusMeta("pending").badgeClass).toContain("status-pending");
    expect(orderStatusMeta("ready").badgeClass).toContain("status-ready");
    expect(orderStatusMeta("out_for_delivery").label).toBe("Out for delivery");
    expect(orderStatusMeta("cancelled").badgeClass).toContain("status-danger");
  });

  it("falls back gracefully for an unknown status", () => {
    expect(orderStatusMeta("mystery" as never).label).toBe("mystery");
    expect(orderStatusMeta("mystery" as never).badgeClass).toContain("status-completed");
  });

  it("applies vertical overrides to preparing/ready labels only", () => {
    expect(orderStatusMeta("preparing", { preparing: "Being packed" }).label).toBe("Being packed");
    expect(orderStatusMeta("ready", { ready: "Ready for collection" }).label).toBe("Ready for collection");
    expect(orderStatusMeta("pending", { preparing: "Being packed" }).label).toBe("Pending");
    expect(orderStatusMeta("preparing").label).toBe("Preparing"); // no overrides = unchanged
  });
});
