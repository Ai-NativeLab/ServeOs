import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { CAPTURED_SURFACES, SHOT_MATRIX, posShotPath, shotPath } from "./shots";
import { SURFACE_KEYS } from "../_content/surfaces";
import { VERTICAL_IDS } from "@/server/verticals";

describe("shotPath", () => {
  it("builds a public path from trade and surface", () => {
    expect(shotPath("pharmacy", "dashboard")).toBe("/marketing/shots/pharmacy/dashboard.png");
  });

  it("carries no locale, because the app's UI chrome is English-only", () => {
    expect(shotPath("retail", "storefront")).not.toMatch(/\.(ar|en)\./);
  });
});

describe("posShotPath", () => {
  it("is a single asset — the counter looks the same whatever it sells", () => {
    expect(posShotPath()).toBe("/marketing/shots/pos.png");
  });
});

describe("SHOT_MATRIX", () => {
  it("captures 8 shots", () => {
    expect(SHOT_MATRIX).toHaveLength(8);
  });

  it("captures every automated surface for every trade", () => {
    for (const trade of VERTICAL_IDS) {
      for (const surface of CAPTURED_SURFACES) {
        expect(SHOT_MATRIX).toContainEqual({ trade, surface });
      }
    }
  });

  it("only automates surfaces the tour actually renders", () => {
    for (const surface of CAPTURED_SURFACES) {
      expect(SURFACE_KEYS).toContain(surface);
    }
  });

  it("does not automate POS, which is a separate Vite app rather than a route", () => {
    expect(CAPTURED_SURFACES).not.toContain("pos");
  });

  it("has no duplicate paths", () => {
    const paths = SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface));
    expect(new Set(paths).size).toBe(paths.length);
  });

  // Enabled by the capture task once the files exist. Until then the screenshot
  // slots render their empty frame, which is expected.
  it.skip("every referenced shot exists on disk", () => {
    const referenced = [...SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface)), posShotPath()];
    const missing = referenced.filter((x) => !existsSync(path.join(process.cwd(), "public", x)));
    expect(missing).toEqual([]);
  });
});
