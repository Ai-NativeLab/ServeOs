import { describe, it, expect } from "vitest";
import { nextStatuses, canTransition } from "./state-machine";

describe("order state machine", () => {
  it("pending can go to confirmed/rejected/cancelled", () => {
    expect(nextStatuses("pending", "delivery").sort()).toEqual(["cancelled", "confirmed", "rejected"]);
  });
  it("ready → out_for_delivery for delivery, → completed for pickup", () => {
    expect(canTransition("ready", "out_for_delivery", "delivery")).toBe(true);
    expect(canTransition("ready", "out_for_delivery", "pickup")).toBe(false);
    expect(canTransition("ready", "completed", "pickup")).toBe(true);
    expect(canTransition("ready", "completed", "delivery")).toBe(false);
  });
  it("pickup never enters out_for_delivery", () => {
    expect(nextStatuses("ready", "pickup")).not.toContain("out_for_delivery");
  });
  it("terminal states have no transitions", () => {
    for (const s of ["completed", "rejected", "cancelled"] as const) {
      expect(nextStatuses(s, "delivery")).toEqual([]);
    }
  });
  it("rejects illegal jumps", () => {
    expect(canTransition("pending", "completed", "pickup")).toBe(false);
    expect(canTransition("confirmed", "rejected", "delivery")).toBe(false);
  });
});
