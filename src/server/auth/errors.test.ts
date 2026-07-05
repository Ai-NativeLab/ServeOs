import { describe, it, expect } from "vitest";
import { StaffContactTakenError } from "./errors";

describe("auth errors", () => {
  it("StaffContactTakenError carries a code and localized messages", () => {
    const err = new StaffContactTakenError("dup@roma.com");
    expect(err.code).toBe("staff_contact_taken");
    expect(err.messageFor("en")).toContain("already in use");
    expect(err.messageFor("ar")).toContain("مستخدم");
  });
});
