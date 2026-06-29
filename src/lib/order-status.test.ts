import { describe, it, expect } from "vitest";
import { orderStatusMeta } from "./order-status";

describe("orderStatusMeta", () => {
  it("maps known statuses to a label and badge class", () => {
    expect(orderStatusMeta("pending").label).toBe("Pending");
    expect(orderStatusMeta("ready").badgeClass).toContain("green");
    expect(orderStatusMeta("out_for_delivery").label).toBe("Out for delivery");
    expect(orderStatusMeta("cancelled").badgeClass).toContain("red");
  });

  it("falls back gracefully for an unknown status", () => {
    expect(orderStatusMeta("mystery" as never).label).toBe("mystery");
  });
});
