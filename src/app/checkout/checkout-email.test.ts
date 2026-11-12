import { describe, expect, it } from "vitest";
import { checkoutEmailError, checkoutEmailPayload } from "./checkout-email";

describe("the checkout's tax-receipt email", () => {
  it("is never sent by a tenant that does not file with ETA — the body is what it was before the field", () => {
    expect(checkoutEmailPayload(false, "ahmed@example.test")).toEqual({});
    expect(JSON.stringify({ customerName: "A", ...checkoutEmailPayload(false, "x") })).toBe('{"customerName":"A"}');
  });

  it("is never checked for such a tenant, so a stale saved value cannot block their checkout", () => {
    expect(checkoutEmailError(false, "not-an-email")).toBeNull();
  });

  it("is sent, and shape-checked, for a fiscal (EG + ETA-active) tenant", () => {
    expect(checkoutEmailPayload(true, "ahmed@example.test")).toEqual({ customerEmail: "ahmed@example.test" });
    expect(checkoutEmailError(true, "ahmed@@example")).toMatch(/doesn't look right/);
    expect(checkoutEmailError(true, "  ")).toBeNull();
    expect(checkoutEmailError(true, "ahmed@example.test")).toBeNull();
  });
});
