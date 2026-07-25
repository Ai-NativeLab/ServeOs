import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS } from "./permissions";

describe("POS permissions", () => {
  it("lets staff sell but not discount, void, or refund", () => {
    expect(ROLE_PERMISSIONS.staff).toContain("pos:sell");
    expect(ROLE_PERMISSIONS.staff).not.toContain("pos:discount");
    expect(ROLE_PERMISSIONS.staff).not.toContain("pos:void");
    expect(ROLE_PERMISSIONS.staff).not.toContain("pos:refund");
  });

  it("lets managers and owners authorize everything at the POS", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(ROLE_PERMISSIONS[role]).toEqual(
        expect.arrayContaining(["pos:sell", "pos:discount", "pos:void", "pos:refund"]),
      );
    }
  });
});
