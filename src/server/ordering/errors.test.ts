import { describe, it, expect } from "vitest";
import { OrderValidationError, BranchNotAcceptingOrdersError, AreaNotDeliverableError, MinimumOrderNotMetError, InvalidTransitionError, OrderNotFoundError } from "./errors";

describe("ordering errors", () => {
  it("carry codes and localized messages", () => {
    expect(new OrderValidationError("x").code).toBe("order_validation");
    expect(new BranchNotAcceptingOrdersError().messageFor("ar")).toContain("الطلب");
    const min = new MinimumOrderNotMetError("100");
    expect(min.minimum).toBe("100");
    expect(min.messageFor("en")).toContain("100");
    expect(new InvalidTransitionError("pending", "completed").messageFor("en")).toContain("pending");
    expect(new AreaNotDeliverableError().code).toBe("area_not_deliverable");
    expect(new OrderNotFoundError().code).toBe("order_not_found");
  });
});
