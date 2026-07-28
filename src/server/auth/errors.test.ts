import { describe, it, expect } from "vitest";
import {
  StaffContactTakenError,
  NotSignedInError,
  ForbiddenError,
  adminAuthRedirectPath,
} from "./errors";

describe("auth errors", () => {
  it("StaffContactTakenError carries a code and localized messages", () => {
    const err = new StaffContactTakenError("dup@roma.com");
    expect(err.code).toBe("staff_contact_taken");
    expect(err.messageFor("en")).toContain("already in use");
    expect(err.messageFor("ar")).toContain("مستخدم");
  });
});

describe("adminAuthRedirectPath", () => {
  it("sends a signed-out visitor to the login form", () => {
    expect(adminAuthRedirectPath(new NotSignedInError())).toBe("/admin/login");
  });

  it("sends a signed-in non-super-admin to no-access, NOT the login form", () => {
    // Re-prompting for credentials that are already correct is what made the
    // production failure unreadable: the form re-renders clean, so it looks
    // like a password problem when it is a missing role.
    expect(adminAuthRedirectPath(new ForbiddenError())).toBe("/admin/no-access");
  });

  it("returns null for a database outage so it surfaces as a real error", () => {
    // Must not be reinterpreted as an auth failure — otherwise an
    // infrastructure incident is indistinguishable from a wrong password.
    expect(adminAuthRedirectPath(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBeNull();
  });

  it("returns null for a missing-column schema error", () => {
    expect(adminAuthRedirectPath(new Error('column "trial_ends_at" does not exist'))).toBeNull();
  });

  it("returns null for a non-Error value", () => {
    expect(adminAuthRedirectPath("forbidden")).toBeNull();
    expect(adminAuthRedirectPath(undefined)).toBeNull();
  });
});
