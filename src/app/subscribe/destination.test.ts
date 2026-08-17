import { describe, it, expect } from "vitest";
import { subscribeDestination } from "./destination";

describe("subscribeDestination", () => {
  it("sends an unknown plan key to the pricing page", () => {
    expect(subscribeDestination({ planKey: "platinum", planExists: false, tenantSlug: null }))
      .toEqual({ kind: "redirect", href: "/pricing" });
  });

  it("sends an absent plan key to the pricing page", () => {
    expect(subscribeDestination({ planKey: undefined, planExists: false, tenantSlug: null }))
      .toEqual({ kind: "redirect", href: "/pricing" });
  });

  it("sends the free plan to registration carrying its key", () => {
    expect(subscribeDestination({ planKey: "basic", planExists: true, tenantSlug: null }))
      .toEqual({ kind: "redirect", href: "/register?plan=basic" });
  });

  it("sends a real customer to billing with the plan highlighted", () => {
    expect(subscribeDestination({ planKey: "enterprise", planExists: true, tenantSlug: "zeytoun" }))
      .toEqual({ kind: "redirect", href: "/dashboard/settings/billing?plan=enterprise" });
  });

  // The reported defect. The marketing page hands out a real session through
  // /api/demo/login one click earlier, so "is signed in" was never the same
  // question as "is a customer" — and treating them as one delivered prospects
  // into the demo tenant's billing page.
  it("treats a demo session as a prospect, not a customer", () => {
    expect(subscribeDestination({ planKey: "enterprise", planExists: true, tenantSlug: "demo-pharmacy" }))
      .toEqual({ kind: "enquire", planKey: "enterprise" });
  });

  it("asks a signed-out visitor to enquire about a paid plan", () => {
    expect(subscribeDestination({ planKey: "growth", planExists: true, tenantSlug: null }))
      .toEqual({ kind: "enquire", planKey: "growth" });
  });

  it("sends a demo visitor choosing the free plan to registration", () => {
    expect(subscribeDestination({ planKey: "basic", planExists: true, tenantSlug: "demo-retail" }))
      .toEqual({ kind: "redirect", href: "/register?plan=basic" });
  });
});
