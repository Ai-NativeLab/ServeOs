import { describe, it, expect } from "vitest";
import { dashboardNavItems } from "./nav-items";

describe("dashboardNavItems", () => {
  it("shows staff only Orders (no Home/Payments/Menu/Settings)", () => {
    const hrefs = dashboardNavItems(["staff"]).map((i) => i.href);
    expect(hrefs).toEqual(["/dashboard/orders"]);
  });

  it("does not show staff the Payments confirmation queue (owner/manager only)", () => {
    const labels = dashboardNavItems(["staff"]).map((i) => i.label);
    expect(labels).not.toContain("Payments");
  });

  it("shows owners the full nav including Home, Payments, Settings, Audit and Customers", () => {
    const labels = dashboardNavItems(["owner"]).map((i) => i.label);
    expect(labels).toEqual([
      "Home", "Analytics", "Orders", "Payments", "Menu", "Branches", "Banners", "Settings", "Audit", "Customers", "Prescriptions",
    ]);
  });

  it("shows Audit to owner and manager but never staff (audit:view)", () => {
    expect(dashboardNavItems(["owner"]).map((i) => i.href)).toContain("/dashboard/audit");
    expect(dashboardNavItems(["manager"]).map((i) => i.href)).toContain("/dashboard/audit");
    expect(dashboardNavItems(["staff"]).map((i) => i.href)).not.toContain("/dashboard/audit");
  });

  it("points Settings at the new settings hub", () => {
    const settings = dashboardNavItems(["owner"]).find((i) => i.label === "Settings");
    expect(settings?.href).toBe("/dashboard/settings");
  });

  it("gives managers the full nav (Home through Settings), including Payments", () => {
    const labels = dashboardNavItems(["manager"]).map((i) => i.label);
    expect(labels).toContain("Home");
    expect(labels).toContain("Payments");
    expect(labels).toContain("Settings");
  });
});

describe("prescriptions nav (P3)", () => {
  it("shows Prescriptions to a pharmacist and to owners, never manager or staff", () => {
    expect(dashboardNavItems(["pharmacist"]).map((i) => i.href)).toContain("/dashboard/prescriptions");
    expect(dashboardNavItems(["owner"]).map((i) => i.href)).toContain("/dashboard/prescriptions");
    expect(dashboardNavItems(["manager"]).map((i) => i.href)).not.toContain("/dashboard/prescriptions");
    expect(dashboardNavItems(["staff"]).map((i) => i.href)).not.toContain("/dashboard/prescriptions");
  });
});
