import { describe, it, expect } from "vitest";
import { shouldReleaseMigrate } from "./release-guard";

// This guard is the only thing standing between a pull request and the
// production schema. Preview deployments share the production DATABASE_URL, so
// if `vercel-build` ever migrated from a feature branch it would apply unshipped
// schema to production before anyone reviewed it. It had no test until an
// untested query took the admin console down and made the point.
describe("shouldReleaseMigrate", () => {
  it("runs migrations for a production deployment", () => {
    expect(shouldReleaseMigrate("production")).toBe(true);
  });

  it("does NOT run for a preview deployment — this is what a PR builds as", () => {
    expect(shouldReleaseMigrate("preview")).toBe(false);
  });

  it("does NOT run for a development deployment", () => {
    expect(shouldReleaseMigrate("development")).toBe(false);
  });

  it("does NOT run when VERCEL_ENV is unset, e.g. a local or CI build", () => {
    expect(shouldReleaseMigrate(undefined)).toBe(false);
    expect(shouldReleaseMigrate("")).toBe(false);
  });

  it("fails closed on an unrecognised value rather than assuming production", () => {
    // A renamed or new Vercel environment must never be treated as production.
    expect(shouldReleaseMigrate("staging")).toBe(false);
    expect(shouldReleaseMigrate("Production")).toBe(false);
    expect(shouldReleaseMigrate("production ")).toBe(false);
  });
});
