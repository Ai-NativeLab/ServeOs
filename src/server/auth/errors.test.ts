import { describe, it, expect } from "vitest";
import {
  StaffContactTakenError,
  NotSignedInError,
  ForbiddenError,
  isAdminAuthError,
} from "./errors";

describe("auth errors", () => {
  it("StaffContactTakenError carries a code and localized messages", () => {
    const err = new StaffContactTakenError("dup@roma.com");
    expect(err.code).toBe("staff_contact_taken");
    expect(err.messageFor("en")).toContain("already in use");
    expect(err.messageFor("ar")).toContain("مستخدم");
  });
});

describe("isAdminAuthError", () => {
  it("classifies a missing session as an auth failure", () => {
    expect(isAdminAuthError(new NotSignedInError())).toBe(true);
  });

  it("classifies a signed-in non-super-admin as an auth failure", () => {
    expect(isAdminAuthError(new ForbiddenError())).toBe(true);
  });

  it("does not classify a database outage as an auth failure", () => {
    // A DB outage must surface as a real error, not a silent bounce to the
    // login form — otherwise an infrastructure incident is indistinguishable
    // from a wrong password, which is what made the prod admin-login failure
    // impossible to read.
    expect(isAdminAuthError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(false);
  });

  it("does not classify a missing-column schema error as an auth failure", () => {
    expect(isAdminAuthError(new Error('column "trial_ends_at" does not exist'))).toBe(false);
  });

  it("does not classify a non-Error value as an auth failure", () => {
    expect(isAdminAuthError("forbidden")).toBe(false);
    expect(isAdminAuthError(undefined)).toBe(false);
  });
});
