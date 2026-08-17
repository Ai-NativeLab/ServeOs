import { describe, it, expect } from "vitest";
import { marketingLocaleAction } from "./marketing-locale";

describe("marketingLocaleAction", () => {
  it("rewrites the bare root to the Arabic route", () => {
    expect(marketingLocaleAction("/")).toEqual({ kind: "rewrite", pathname: "/ar", locale: "ar" });
  });

  it("passes /en through and reports the English locale", () => {
    expect(marketingLocaleAction("/en")).toEqual({ kind: "pass", locale: "en" });
  });

  it("passes nested English paths through", () => {
    expect(marketingLocaleAction("/en/anything")).toEqual({ kind: "pass", locale: "en" });
  });

  it("redirects an explicit /ar to the canonical root", () => {
    expect(marketingLocaleAction("/ar")).toEqual({ kind: "redirect", pathname: "/" });
  });

  it("redirects a nested /ar path to its unprefixed form", () => {
    expect(marketingLocaleAction("/ar/anything")).toEqual({ kind: "redirect", pathname: "/anything" });
  });

  it("rewrites the bare pricing path to the Arabic route", () => {
    expect(marketingLocaleAction("/pricing")).toEqual({
      kind: "rewrite",
      pathname: "/ar/pricing",
      locale: "ar",
    });
  });

  it("passes the English pricing path through", () => {
    expect(marketingLocaleAction("/en/pricing")).toEqual({ kind: "pass", locale: "en" });
  });

  it("redirects an explicit Arabic pricing path to its canonical form", () => {
    expect(marketingLocaleAction("/ar/pricing")).toEqual({ kind: "redirect", pathname: "/pricing" });
  });

  // The allowlist must never become a catch-all: the `none` fallthrough is what
  // keeps sign-in out of the marketing segment.
  it("does not rewrite a path that merely starts with an allowlisted one", () => {
    expect(marketingLocaleAction("/pricing-guide")).toEqual({ kind: "none" });
  });

  it("leaves non-marketing paths alone", () => {
    expect(marketingLocaleAction("/login")).toEqual({ kind: "none" });
    expect(marketingLocaleAction("/register")).toEqual({ kind: "none" });
    expect(marketingLocaleAction("/api/health")).toEqual({ kind: "none" });
  });

  it("does not treat a path that merely starts with the letters as a locale", () => {
    expect(marketingLocaleAction("/article")).toEqual({ kind: "none" });
    expect(marketingLocaleAction("/enroll")).toEqual({ kind: "none" });
  });
});
