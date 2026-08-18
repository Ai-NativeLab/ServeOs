import { describe, it, expect } from "vitest";
import { postRegisterHref } from "./plan-redirect";

describe("postRegisterHref", () => {
  it("lands on the dashboard when no plan was carried", () => {
    expect(postRegisterHref({ planKey: undefined, planExists: false, planIsFree: false })).toBe("/dashboard");
  });

  it("ignores a plan key that is not a real plan", () => {
    expect(postRegisterHref({ planKey: "platinum", planExists: false, planIsFree: false })).toBe("/dashboard");
  });

  it("opens billing with a carried plan highlighted", () => {
    expect(postRegisterHref({ planKey: "enterprise", planExists: true, planIsFree: false })).toBe(
      "/dashboard/settings/billing?plan=enterprise",
    );
  });

  // Free carries its key through the fork, but there is nothing to highlight:
  // the tenant already has it the moment it is created.
  it("sends the free plan to the dashboard", () => {
    expect(postRegisterHref({ planKey: "basic", planExists: true, planIsFree: true })).toBe("/dashboard");
  });

  // "Free" is the price, not the key. A repriced plan must follow the price.
  it("treats any zero-priced plan as free, whatever its key", () => {
    expect(postRegisterHref({ planKey: "starter", planExists: true, planIsFree: true })).toBe("/dashboard");
  });
});
