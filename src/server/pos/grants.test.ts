import { describe, it, expect, vi, afterEach } from "vitest";
import { issueGrant, consumeGrant, GRANT_TTL_MS } from "./grants";
import { PosForbiddenError } from "./errors";

afterEach(() => vi.useRealTimers());

describe("grants", () => {
  it("consumes a valid grant once and returns the authorizer", () => {
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    expect(consumeGrant("t1", token, "pos:discount")).toBe("mgr-1");
  });

  it("refuses to reuse a grant", () => {
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    consumeGrant("t1", token, "pos:discount");
    expect(() => consumeGrant("t1", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses a grant issued for a different permission", () => {
    const token = issueGrant("t1", "pos:void", "mgr-1");
    expect(() => consumeGrant("t1", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses a grant issued for a different tenant", () => {
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    expect(() => consumeGrant("t2", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses an expired grant", () => {
    vi.useFakeTimers();
    const token = issueGrant("t1", "pos:discount", "mgr-1");
    vi.advanceTimersByTime(GRANT_TTL_MS + 1);
    expect(() => consumeGrant("t1", token, "pos:discount")).toThrow(PosForbiddenError);
  });

  it("refuses an unknown token", () => {
    expect(() => consumeGrant("t1", "nope", "pos:discount")).toThrow(PosForbiddenError);
  });
});
