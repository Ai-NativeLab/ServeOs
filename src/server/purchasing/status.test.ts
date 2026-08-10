import { describe, it, expect } from "vitest";
import { canTransition, assertTransition, receiptStatus } from "./status";
import { InvalidPoTransitionError } from "./errors";

describe("PO state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    expect(canTransition("sent", "partially_received")).toBe(true);
    expect(canTransition("sent", "received")).toBe(true);
    expect(canTransition("partially_received", "received")).toBe(true);
    expect(canTransition("received", "closed")).toBe(true);
  });
  it("allows cancel only from draft/sent", () => {
    expect(canTransition("draft", "cancelled")).toBe(true);
    expect(canTransition("sent", "cancelled")).toBe(true);
    expect(canTransition("partially_received", "cancelled")).toBe(false);
    expect(canTransition("received", "cancelled")).toBe(false);
  });
  it("forbids illegal jumps and re-opening terminals", () => {
    expect(canTransition("draft", "received")).toBe(false);
    expect(canTransition("received", "draft")).toBe(false);
    expect(canTransition("cancelled", "sent")).toBe(false);
    expect(canTransition("closed", "received")).toBe(false);
  });
  it("assertTransition throws on an illegal move", () => {
    expect(() => assertTransition("received", "cancelled")).toThrow(InvalidPoTransitionError);
  });
  it("receiptStatus derives from ordered vs received", () => {
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "0" }])).toBe("sent");
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "4" }])).toBe("partially_received");
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "10" }])).toBe("received");
    expect(receiptStatus([{ qtyOrdered: "10", qtyReceived: "12" }])).toBe("received"); // over-receipt
  });
});
