import { describe, it, expect } from "vitest";
import { dashboardNavItems } from "./nav-items";

describe("dashboardNavItems", () => {
  it("shows staff only Orders and Inventory (no Home/Payments/Menu/Settings)", () => {
    const hrefs = dashboardNavItems(["staff"]).map((i) => i.href);
    // Staff reach Inventory deliberately: they hold inventory:view + inventory:count
    // so they can count shelves, but not inventory:manage.
    expect(hrefs).toEqual(["/dashboard/orders", "/dashboard/orders/history", "/dashboard/inventory"]);
    expect(hrefs).not.toContain("/dashboard/purchase-orders");
    expect(hrefs).not.toContain("/dashboard/suppliers");
  });

  it("shows Purchasing + Suppliers to owner and manager but never staff (purchasing:manage)", () => {
    expect(dashboardNavItems(["owner"]).map((i) => i.label)).toContain("Purchasing");
    expect(dashboardNavItems(["manager"]).map((i) => i.label)).toContain("Purchasing");
    expect(dashboardNavItems(["owner"]).map((i) => i.href)).toContain("/dashboard/purchase-orders");
    expect(dashboardNavItems(["manager"]).map((i) => i.href)).toContain("/dashboard/purchase-orders");
    expect(dashboardNavItems(["staff"]).map((i) => i.label)).not.toContain("Purchasing");
    expect(dashboardNavItems(["staff"]).map((i) => i.label)).not.toContain("Suppliers");
  });

  it("does not show staff the Payments confirmation queue (owner/manager only)", () => {
    const labels = dashboardNavItems(["staff"]).map((i) => i.label);
    expect(labels).not.toContain("Payments");
  });

  it("shows owners the full nav including Home, Payments, Settings, Audit and Customers", () => {
    const labels = dashboardNavItems(["owner"]).map((i) => i.label);
    expect(labels).toEqual([
      "Home", "Analytics", "Orders", "Sales history", "Payments", "Menu", "Inventory", "Purchasing", "Suppliers", "Branches", "Banners", "Settings", "Audit", "Customers", "Prescriptions",
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

describe("fiscal nav (Spec 11)", () => {
  it("is hidden unless the tenant is Egyptian AND the user is the owner", () => {
    const hrefs = (roles: Parameters<typeof dashboardNavItems>[0], country?: string | null) =>
      dashboardNavItems(roles, "Menu", country).map((i) => i.href);

    // Owner of an EG tenant: the only combination that shows it.
    expect(hrefs(["owner"], "EG")).toContain("/dashboard/fiscal");
    // fiscal:manage is owner-only, so no other role sees it even in Egypt.
    expect(hrefs(["manager"], "EG")).not.toContain("/dashboard/fiscal");
    expect(hrefs(["staff"], "EG")).not.toContain("/dashboard/fiscal");
    // ETA e-invoicing is an Egypt-specific obligation — an owner elsewhere
    // would get a setup screen that can never submit anything.
    expect(hrefs(["owner"], "AE")).not.toContain("/dashboard/fiscal");
    expect(hrefs(["owner"], null)).not.toContain("/dashboard/fiscal");
    // And a caller with no tenant in hand gets the pre-fiscal nav unchanged,
    // which is what keeps the exact-array owner assertion above honest.
    expect(hrefs(["owner"])).not.toContain("/dashboard/fiscal");
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
