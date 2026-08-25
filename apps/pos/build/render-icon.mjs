// Renders the ServeOS brand mark into the PNG masters electron-builder turns
// into .icns and .ico. Run it when the brand mark changes, not on every build:
//
//   node apps/pos/build/render-icon.mjs
//
// The generated PNGs are committed. Rasterising at package time would put
// Playwright's chromium on the critical path of every release build — a ~150MB
// download on a cold CI runner to redraw six shapes that change once a year.
//
// Source of truth is src/app/icon.svg, the same mark the web favicon uses, so
// the till and the dashboard cannot drift apart.
//
// Two masters, because the platforms disagree about margins:
//
//   icon.png     full-bleed. Windows draws .ico into a tile it owns, and any
//                transparent margin baked into the art reads as a small icon.
//   icon-mac.png inset ~10%. macOS does NOT add padding — every system app's
//                artwork carries its own, so a full-bleed icon sits visibly
//                larger than its neighbours in the dock.
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const SIZE = 1024;

/** Wraps the mark in a transparent canvas, inset by `insetPct` on every side. */
function page(svg, insetPct) {
  const box = 100 - insetPct * 2;
  return `<!doctype html>
<style>
  html, body { margin: 0; background: transparent; }
  body { width: ${SIZE}px; height: ${SIZE}px; display: grid; place-items: center; }
  .mark { width: ${box}%; height: ${box}%; }
  .mark svg { width: 100%; height: 100%; display: block; }
</style>
<div class="mark">${svg}</div>`;
}

const svg = await readFile(path.join(repoRoot, "src/app/icon.svg"), "utf8");
const browser = await chromium.launch();

try {
  for (const [file, inset] of [["icon.png", 0], ["icon-mac.png", 10]]) {
    const tab = await browser.newPage({
      viewport: { width: SIZE, height: SIZE },
      deviceScaleFactor: 1,
    });
    await tab.setContent(page(svg, inset));
    // omitBackground keeps the canvas alpha — without it the inset master ships
    // a white square behind the mark, which macOS renders as an opaque tile.
    const png = await tab.screenshot({ omitBackground: true, type: "png" });
    await writeFile(path.join(here, file), png);
    await tab.close();
    console.log(`wrote build/${file} (${SIZE}x${SIZE}, inset ${inset}%)`);
  }
} finally {
  await browser.close();
}
