import { describe, it, expect } from "vitest";
import { authorize, UnauthorizedError } from "@/server/rbac/authorize";

// Guard-level test: the permission ladder each purchasing/suppliers route
// runs. A real end-to-end request would need a signed-in session; the routes
// are thin — resolve context → authorize → service — so this asserts the exact
// gate that maps staff requests to 403.
describe("purchasing route guards", () => {
  it("staff may neither manage purchasing nor suppliers", () => {
    expect(() => authorize(["staff"], "purchasing:manage")).toThrow(UnauthorizedError);
    expect(() => authorize(["staff"], "suppliers:manage")).toThrow(UnauthorizedError);
  });

  it("owner and manager pass both purchasing:manage and suppliers:manage", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(() => authorize([role], "purchasing:manage")).not.toThrow();
      expect(() => authorize([role], "suppliers:manage")).not.toThrow();
    }
  });

  it("reorder config and sweep are inventory:manage — staff blocked, owner/manager pass", () => {
    expect(() => authorize(["staff"], "inventory:manage")).toThrow(UnauthorizedError);
    for (const role of ["owner", "manager"] as const) {
      expect(() => authorize([role], "inventory:manage")).not.toThrow();
    }
  });
});
