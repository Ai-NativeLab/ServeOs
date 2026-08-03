import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERTICAL_IDS, VERTICAL_ACCENTS } from "./registry";

/**
 * The storefront scopes each vertical's accent onto --primary for its whole
 * subtree (StorefrontShell), so every control styled with bg-primary /
 * text-primary / border-primary follows the vertical automatically.
 *
 * These are structural assertions, not screenshots: they pin the mechanism
 * that broke once — accent reaching only the section heading while product
 * cards, the search ring and CartBar stayed restaurant coral.
 */
const SHELL = "src/app/_components/storefront/templates/StorefrontShell.tsx";
const CHARTS = "src/components/admin/charts.tsx";

describe("storefront accent contract", () => {
  it("the shell scopes --primary to the vertical's accent", () => {
    const src = readFileSync(SHELL, "utf8");
    expect(src).toMatch(/"--primary":\s*accent/);
  });

  it("the section heading follows the token rather than an inline colour", () => {
    const src = readFileSync(SHELL, "utf8");
    // An inline style={{ color: accent }} was how only the heading got the
    // accent while every control stayed coral.
    expect(src).not.toMatch(/style=\{\{\s*color:\s*accent\s*\}\}/);
  });

  it("every vertical defines a distinct accent for that override to carry", () => {
    for (const id of VERTICAL_IDS) {
      expect(VERTICAL_ACCENTS[id], id).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(new Set(Object.values(VERTICAL_ACCENTS)).size).toBe(VERTICAL_IDS.length);
  });
});

/** Strip comments so a line EXPLAINING the old bug doesn't read as the bug —
 *  the same discipline src/server/audit/coverage.ts uses when scanning source. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("admin chart colours", () => {
  it("reference the design tokens directly — --primary is a hex, so hsl(var()) is invalid", () => {
    const code = stripComments(readFileSync(CHARTS, "utf8"));
    // The bug this pins: wrapping a hex token in hsl() renders colourless.
    expect(code).not.toMatch(/hsl\(var\(--primary\)/);
    // All three charts (line stroke, area stroke+fill, bar fill) carry a colour.
    expect(code.match(/var\(--primary\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
