import { describe, it, expect } from "vitest";
import { classifyHost } from "./middleware-routing";

const root = "serveos.localhost";

describe("classifyHost", () => {
  it("routes app host to dashboard", () => {
    expect(classifyHost("app.serveos.localhost", root)).toEqual({ surface: "dashboard" });
  });
  it("routes admin host to admin", () => {
    expect(classifyHost("admin.serveos.localhost", root)).toEqual({ surface: "admin" });
  });
  it("routes a subdomain to storefront with the slug", () => {
    expect(classifyHost("roma.serveos.localhost", root)).toEqual({ surface: "storefront", slug: "roma" });
  });
  it("routes the bare root to marketing", () => {
    expect(classifyHost("serveos.localhost", root)).toEqual({ surface: "marketing" });
  });
  it("strips a port before classifying", () => {
    expect(classifyHost("app.serveos.localhost:3000", root)).toEqual({ surface: "dashboard" });
  });
  it("classifies a multi-label host as marketing", () => {
    expect(classifyHost("a.b.serveos.localhost", root)).toEqual({ surface: "marketing" });
  });
  it("is case-insensitive on the host", () => {
    expect(classifyHost("ROMA.serveos.localhost", root)).toEqual({ surface: "storefront", slug: "roma" });
  });
});
