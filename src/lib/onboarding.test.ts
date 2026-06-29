import { describe, it, expect } from "vitest";
import { onboardingSteps } from "./onboarding";

describe("onboardingSteps", () => {
  it("marks steps done based on input flags", () => {
    const steps = onboardingSteps({ branchCount: 1, publishedProductCount: 0, hasOpeningHours: true, acceptingOrders: false });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.done]));
    expect(byKey.branch).toBe(true);
    expect(byKey.menu).toBe(false);
    expect(byKey.hours).toBe(true);
    expect(byKey.live).toBe(false);
  });

  it("returns the four setup steps in order with hrefs", () => {
    const steps = onboardingSteps({ branchCount: 0, publishedProductCount: 0, hasOpeningHours: false, acceptingOrders: false });
    expect(steps.map((s) => s.key)).toEqual(["branch", "menu", "hours", "live"]);
    expect(steps.every((s) => s.href.startsWith("/dashboard/"))).toBe(true);
  });
});
