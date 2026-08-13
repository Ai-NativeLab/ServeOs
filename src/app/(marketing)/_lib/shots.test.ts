import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CAPTURED_SURFACES,
  DEVICE_VIEWPORT,
  SHOT_MATRIX,
  SURFACE_DEVICE,
  deviceAspect,
  isWindowed,
  posShotPath,
  shotPath,
} from "./shots";
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

  // No longer skipped: every capture, including the till, now exists. This is
  // the test that would have caught pos.png being referenced but never
  // produced — the POS band shipped a broken-image icon to production.
  it("every referenced shot exists on disk", () => {
    const referenced = [...SHOT_MATRIX.map((s) => shotPath(s.trade, s.surface)), posShotPath()];
    const missing = referenced.filter((x) => !existsSync(path.join(process.cwd(), "public", x)));
    expect(missing).toEqual([]);
  });
});

describe("SURFACE_DEVICE", () => {
  it("captures the storefront on a phone, because it is a mobile-first page", () => {
    expect(SURFACE_DEVICE.storefront).toBe("phone");
  });

  it("keeps the genuinely desktop surfaces landscape", () => {
    expect(SURFACE_DEVICE.dashboard).toBe("desktop");
    expect(SURFACE_DEVICE.pos).toBe("till");
  });

  it("assigns a device to every surface the tour renders", () => {
    for (const surface of SURFACE_KEYS) {
      expect(SURFACE_DEVICE[surface]).toBeDefined();
    }
  });

  it("frames everything except the phone as a window", () => {
    expect(isWindowed("phone")).toBe(false);
    expect(isWindowed("desktop")).toBe(true);
    expect(isWindowed("till")).toBe(true);
  });
});

describe("deviceAspect", () => {
  it("derives the frame ratio from the capture viewport, so the two cannot drift", () => {
    expect(deviceAspect("phone")).toBe("390 / 844");
    expect(deviceAspect("desktop")).toBe("1440 / 900");
  });

  it("gives the till a shorter frame than the dashboard", () => {
    expect(DEVICE_VIEWPORT.till.height).toBeLessThan(DEVICE_VIEWPORT.desktop.height);
    expect(DEVICE_VIEWPORT.till.width).toBe(DEVICE_VIEWPORT.desktop.width);
  });
});
