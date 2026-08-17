import { describe, it, expect } from "vitest";
import { postRegisterHref } from "./plan-redirect";

describe("postRegisterHref", () => {
  it("lands on the dashboard when no plan was carried", () => {
    expect(postRegisterHref(undefined, false)).toBe("/dashboard");
  });

  it("ignores a plan key that is not a real plan", () => {
    expect(postRegisterHref("platinum", false)).toBe("/dashboard");
  });

  it("opens billing with a carried plan highlighted", () => {
    expect(postRegisterHref("enterprise", true)).toBe("/dashboard/settings/billing?plan=enterprise");
  });

  // Free carries its key through the fork, but there is nothing to highlight:
  // the tenant already has it the moment it is created.
  it("sends the free plan to the dashboard", () => {
    expect(postRegisterHref("basic", true)).toBe("/dashboard");
  });
});
