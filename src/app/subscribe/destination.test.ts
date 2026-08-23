import { describe, it, expect } from "vitest";
import { subscribeDestination, type SubscribeVisitor } from "./destination";

const visitor = (over: Partial<SubscribeVisitor> = {}): SubscribeVisitor => ({
  planKey: "enterprise",
  planExists: true,
  planIsFree: false,
  tenantSlug: null,
  locale: "en",
  ...over,
});

describe("subscribeDestination", () => {
  it("sends an unknown plan key to the pricing page", () => {
    expect(subscribeDestination(visitor({ planKey: "platinum", planExists: false })))
      .toEqual({ kind: "redirect", href: "/en/pricing" });
  });

  it("sends an absent plan key to the pricing page", () => {
    expect(subscribeDestination(visitor({ planKey: undefined, planExists: false })))
      .toEqual({ kind: "redirect", href: "/en/pricing" });
  });

  // Arabic owns the unprefixed /pricing, so the fallback must follow the reader
  // rather than dropping an Arabic visitor onto the English page.
  it("returns to the pricing page in the language being read", () => {
    expect(subscribeDestination(visitor({ planExists: false, locale: "ar" })))
      .toEqual({ kind: "redirect", href: "/pricing" });
  });

  it("sends the free plan to registration carrying its key", () => {
    expect(subscribeDestination(visitor({ planKey: "basic", planIsFree: true })))
      .toEqual({ kind: "redirect", href: "/register?plan=basic" });
  });

  // Free is the price, not the key: whatever a zero-priced plan is called, it
  // self-serves, and the card that said "Start free" cannot disagree.
  it("treats any zero-priced plan as free", () => {
    expect(subscribeDestination(visitor({ planKey: "starter", planIsFree: true })))
      .toEqual({ kind: "redirect", href: "/register?plan=starter" });
  });

  it("sends a real customer to billing with the plan highlighted", () => {
    expect(subscribeDestination(visitor({ tenantSlug: "zeytoun" })))
      .toEqual({ kind: "redirect", href: "/dashboard/settings/billing?plan=enterprise" });
  });

  // The reported defect. The marketing page hands out a real session through
  // /api/demo/login one click earlier, so "is signed in" was never the same
  // question as "is a customer" — and treating them as one delivered prospects
  // into the demo tenant's billing page.
  it("treats a demo session as a prospect, not a customer", () => {
    expect(subscribeDestination(visitor({ tenantSlug: "demo-pharmacy" })))
      .toEqual({ kind: "enquire", planKey: "enterprise" });
  });

  it("asks a signed-out visitor to enquire about a paid plan", () => {
    expect(subscribeDestination(visitor({ planKey: "growth" })))
      .toEqual({ kind: "enquire", planKey: "growth" });
  });

  it("sends a demo visitor choosing the free plan to registration", () => {
    expect(subscribeDestination(visitor({ planKey: "basic", planIsFree: true, tenantSlug: "demo-retail" })))
      .toEqual({ kind: "redirect", href: "/register?plan=basic" });
  });

  // A suspended or past-due tenant is still a customer, and billing is exactly
  // where they need to land. Pinned so the rule is a decision, not an oversight.
  it("still sends a customer to billing whatever their tenant's status", () => {
    expect(subscribeDestination(visitor({ tenantSlug: "suspended-shop" })))
      .toEqual({ kind: "redirect", href: "/dashboard/settings/billing?plan=enterprise" });
  });
});
