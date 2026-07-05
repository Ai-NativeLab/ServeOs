import { describe, it, expect } from "vitest";
import { dashboardNavItems } from "./nav-items";

describe("dashboardNavItems", () => {
  it("shows staff only Orders (no Home/Menu/Settings)", () => {
    const hrefs = dashboardNavItems(["staff"]).map((i) => i.href);
    expect(hrefs).toEqual(["/dashboard/orders"]);
  });

  it("shows owners the full nav including Home and Settings", () => {
    const labels = dashboardNavItems(["owner"]).map((i) => i.label);
    expect(labels).toEqual(["Home", "Orders", "Menu", "Branches", "Banners", "Settings"]);
  });

  it("points Settings at the new settings hub", () => {
    const settings = dashboardNavItems(["owner"]).find((i) => i.label === "Settings");
    expect(settings?.href).toBe("/dashboard/settings");
  });

  it("gives managers the full nav (Home through Settings)", () => {
    const labels = dashboardNavItems(["manager"]).map((i) => i.label);
    expect(labels).toContain("Home");
    expect(labels).toContain("Settings");
  });
});
