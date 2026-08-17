import { describe, it, expect } from "vitest";
import { getDemoEntry } from "./entry";
import { VERTICAL_IDS } from "@/server/verticals";

describe("getDemoEntry", () => {
  it("points at a per-trade demo subdomain over https in production", () => {
    expect(getDemoEntry("pharmacy", "serveos.tech")).toEqual({
      storefrontUrl: "https://demo-pharmacy.serveos.tech",
      dashboardUrl: "/api/demo/login?trade=pharmacy",
    });
  });

  it("uses http for local development domains", () => {
    expect(getDemoEntry("restaurant", "serveos.localhost").storefrontUrl).toBe(
      "http://demo-restaurant.serveos.localhost",
    );
  });

  it("builds a distinct entry for every registered trade", () => {
    const urls = VERTICAL_IDS.map((id) => getDemoEntry(id, "serveos.tech").storefrontUrl);
    expect(new Set(urls).size).toBe(VERTICAL_IDS.length);
  });

  it("never points a demo at the showcase tenants", () => {
    for (const id of VERTICAL_IDS) {
      const { storefrontUrl } = getDemoEntry(id, "serveos.tech");
      expect(storefrontUrl).not.toContain("roma");
      expect(storefrontUrl).not.toContain("nobio");
    }
  });
});
