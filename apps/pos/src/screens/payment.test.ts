import { describe, it, expect } from "vitest";
import { splitRemaining, changeFor } from "./PaymentScreen";

describe("splitRemaining", () => {
  it("is the full total with no tenders", () => {
    expect(splitRemaining(125.4, [])).toBe(125.4);
  });

  it("subtracts what has been tendered", () => {
    expect(splitRemaining(100, [{ method: "cash", amount: 40 }])).toBe(60);
  });

  it("is zero, never negative, once covered", () => {
    expect(splitRemaining(100, [{ method: "cash", amount: 100 }])).toBe(0);
  });

  it("rounds to cents rather than drifting", () => {
    expect(splitRemaining(100, [{ method: "cash", amount: 33.33 }, { method: "card", amount: 33.33 }])).toBe(33.34);
  });
});

describe("changeFor", () => {
  it("gives change on cash", () => {
    expect(changeFor({ method: "cash", amount: 90, tenderedAmount: 100 })).toBe(10);
  });

  it("gives no change on card", () => {
    expect(changeFor({ method: "card", amount: 90, tenderedAmount: 100 })).toBe(0);
  });

  it("gives no change when exactly tendered", () => {
    expect(changeFor({ method: "cash", amount: 90, tenderedAmount: 90 })).toBe(0);
  });
});
