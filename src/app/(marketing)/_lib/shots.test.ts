import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { CAPTURED_SURFACES, SHOT_MATRIX, posShotPath, shotPath } from "./shots";
import { SURFACE_KEYS } from "../_content/surfaces";
import { VERTICAL_IDS } from "@/server/verticals";

describe("shotPath", () => {
  it("builds a public path from trade, surface and locale", () => {
    expect(shotPath("pharmacy", "dashboard", "ar")).toBe("/marketing/shots/pharmacy/dashboard.ar.png");
  });

  it("distinguishes locales", () => {
    expect(shotPath("retail", "storefront", "en")).toBe("/marketing/shots/retail/storefront.en.png");
  });
});

describe("posShotPath", () => {
  it("is trade-independent, because the counter looks the same whatever it sells", () => {
    expect(posShotPath("ar")).toBe("/marketing/shots/pos.ar.png");
    expect(posShotPath("en")).toBe("/marketing/shots/pos.en.png");
  });
});

describe("SHOT_MATRIX", () => {
  it("captures 16 shots", () => {
    expect(SHOT_MATRIX).toHaveLength(16);
  });

  it("captures every automated surface for every trade in both locales", () => {
    for (const trade of VERTICAL_IDS) {
      for (const surface of CAPTURED_SURFACES) {
        for (const locale of ["ar", "en"] as const) {
          expect(SHOT_MATRIX).toContainEqual({ trade, surface, locale });
        }
      }
    }
  });

  it("only automates surfaces the tour actually renders", () => {
    for (const surface of CAPTURED_SURFACES) {
      expect(SURFACE_KEYS).toContain(surface);
    }
  });

  it("does not automate POS, which is an Electron app rather than a route", () => {
    expect(CAPTURED_SURFACES).not.toContain("pos");
  });

  it("has no duplicate paths", () => {
    const paths = SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface, s.locale));
    expect(new Set(paths).size).toBe(paths.length);
  });

  // Enabled by the capture task once the files exist. Until then the screenshot
  // slots render broken images in development, which is expected.
  it.skip("every referenced shot exists on disk", () => {
    const referenced = [
      ...SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface, s.locale)),
      ...(["ar", "en"] as const).map(posShotPath),
    ];
    const missing = referenced.filter((x) => !existsSync(path.join(process.cwd(), "public", x)));
    expect(missing).toEqual([]);
  });
});
