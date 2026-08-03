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

describe("audit:view", () => {
  it("is held by owner and manager", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("audit:view");
    expect(ROLE_PERMISSIONS.manager).toContain("audit:view");
  });
  it("is NOT held by staff", () => {
    expect(ROLE_PERMISSIONS.staff).not.toContain("audit:view");
  });
});

describe("reconciliation:manage", () => {
  it("is held by owner and manager, not staff", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("reconciliation:manage");
    expect(ROLE_PERMISSIONS.manager).toContain("reconciliation:manage");
    expect(ROLE_PERMISSIONS.staff).not.toContain("reconciliation:manage");
  });
});

describe("reports permissions", () => {
  it("reports:view + reports:financial are held by owner and manager", () => {
    for (const role of ["owner", "manager"] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain("reports:view");
      expect(ROLE_PERMISSIONS[role]).toContain("reports:financial");
    }
  });
  it("neither is held by staff", () => {
    expect(ROLE_PERMISSIONS.staff).not.toContain("reports:view");
    expect(ROLE_PERMISSIONS.staff).not.toContain("reports:financial");
  });
});

describe("customers:manage", () => {
  it("is held by owner and manager, not staff", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("customers:manage");
    expect(ROLE_PERMISSIONS.manager).toContain("customers:manage");
    expect(ROLE_PERMISSIONS.staff).not.toContain("customers:manage");
  });
});
