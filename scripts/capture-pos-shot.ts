import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { DEVICE_VIEWPORT, SURFACE_DEVICE, posShotPath } from "../src/app/(marketing)/_lib/shots";

/**
 * Captures the POS band's screenshot for the marketing tour.
 *
 * The till is a separate Vite/Electron app (apps/pos), so it is NOT part of
 * capture-marketing-shots.ts — that script drives routes of THIS Next app
 * against seeded demo tenants. This one drives the POS renderer.
 *
 *   cd apps/pos && npx vite --port 5199  # in one terminal — the renderer only,
 *                                        # no Electron and no pairing needed
 *   npm run marketing:pos-shot           # in another
 *
 * Set POS_URL if the renderer is on a different port.
 *
 * WHAT IS REAL HERE, AND WHAT IS NOT.
 *
 * The screenshot is the real POS UI: the shipped React components, the shipped
 * stylesheet, the real cart maths — rendered by the same code that runs on a
 * counter. What is substituted is only the Electron IPC bridge (`window.pos`),
 * which does not exist in a browser: Electron's preload never runs, so the app
 * would crash on its first `window.pos.isPaired()` call.
 *
 * The menu behind the stub is not invented either — it is read from the same
 * seeded demo-restaurant tenant the storefront band is captured from, so the
 * till in the tour is ringing up the very dishes shown on the phone beside it.
 */
const VITE_URL = process.env.POS_URL ?? "http://localhost:5199/";
const DEMO_SLUG = "demo-restaurant";

/**
 * The order rung up before the shutter, so the capture shows a till mid-sale
 * rather than "Tap products to add."
 *
 * Spread across categories because a real ticket is: the grid on the left ends
 * on Grills (the last category visited), while the ticket on the right carries
 * a starter and a drink too. Names must exist in the seeded demo-restaurant
 * catalog — a miss is warned about, not silently dropped.
 */
const TICKET: { category: string; product: string }[] = [
  { category: "Mezze & Salads", product: "Hummus" },
  { category: "Drinks", product: "Fresh Lemon & Mint" },
  { category: "Grills", product: "Grilled Chicken Half" },
  { category: "Grills", product: "Kofta Skewer" },
];

async function main() {
  // Dynamic import so dotenv has already populated DATABASE_URL — same pattern
  // as scripts/pos-demo-seed.ts.
  const { pool } = await import("../src/db/client");
  const { getTenantBySlug } = await import("../src/server/tenancy");
  const { getPublishedMenu } = await import("../src/server/catalog/service");

  const tenant = await getTenantBySlug(DEMO_SLUG);
  if (!tenant) {
    throw new Error(
      `tenant "${DEMO_SLUG}" not found — run \`npm run demo:seed\` before capturing the till`,
    );
  }
  const menu = await getPublishedMenu(tenant.id);
  const productCount = menu.categories.reduce((n, c) => n + c.products.length, 0);
  if (productCount === 0) throw new Error(`tenant "${DEMO_SLUG}" has no published products`);

  const bridgeData = {
    branchName: `${tenant.name} — Downtown`,
    menuJson: JSON.stringify(menu),
    // Egypt's standard VAT, matching what the seeded tenant checks out with.
    pricing: { vatEnabled: true, vatRate: 14, pricesIncludeVat: false, serviceChargeRate: 0 },
    syncedAt: new Date().toISOString(),
  };

  const device = SURFACE_DEVICE.pos;
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: DEVICE_VIEWPORT[device],
    deviceScaleFactor: 2,
  });

  // Injected before any app code runs, so `window.pos` exists by the time
  // App.tsx's first effect fires. Only the reads the till performs on its
  // take-order screen are implemented; anything else throws loudly rather than
  // silently returning undefined and rendering a half-empty screen.
  //
  // Passed as a STRING, not a function. tsx transpiles this file with esbuild,
  // which rewrites nested functions to reference its `__name` helper — and
  // Playwright serialises a function argument by calling toString(), so the
  // helper reference travels to the browser where it does not exist and the
  // init script dies with "__name is not defined". A string is not transpiled.
  await context.addInitScript(`
    (() => {
      const data = ${JSON.stringify(bridgeData)};
      const notImplemented = (name) => () => {
        throw new Error("pos bridge stub: " + name + " is not implemented for screenshot capture");
      };
      Object.defineProperty(window, "pos", {
        configurable: true,
        value: {
          isPaired: async () => true,
          branchName: async () => data.branchName,
          cashier: async () => ({ name: "Mona Fathy", permissions: ["pos.sell", "pos.discount"] }),
          currentShift: async () => ({
            shift: { id: "shift-demo", openedAt: data.syncedAt, openingFloat: 500 },
            report: null,
          }),
          getMenu: async () => ({ json: data.menuJson, pricing: data.pricing, syncedAt: data.syncedAt }),
          getOrders: async () => [],
          listHeldTickets: async () => [],
          signOutCashier: async () => {},
          holdTicket: notImplemented("holdTicket"),
          recordSale: notImplemented("recordSale"),
        },
      });
    })();
  `);

  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(VITE_URL, { waitUntil: "networkidle" });

  // The take-order grid is the till's front door. Waiting on a product tile
  // also proves the stubbed menu actually parsed.
  await page.waitForSelector("main, header", { timeout: 30_000 });
  await page.waitForTimeout(1_500);

  for (const { category, product } of TICKET) {
    const tab = page.getByRole("button", { name: category, exact: true }).first();
    if (await tab.count()) {
      await tab.click();
      await page.waitForTimeout(200);
    }
    const tile = page.getByRole("button", { name: new RegExp(product, "i") }).first();
    if (!(await tile.count())) {
      console.warn(`  · "${product}" not on the seeded menu — skipped`);
      continue;
    }
    await tile.click();
    await page.waitForTimeout(250);

    // A product carrying modifier groups opens the selection sheet instead of
    // dropping straight onto the ticket, and that sheet is a full-screen
    // overlay — leave it open and every later click hits the backdrop. The
    // seeded defaults are already selected, so confirming is all that is
    // needed. Products without modifiers never show it.
    const addButton = page.getByRole("button", { name: "Add", exact: true });
    if (await addButton.count()) {
      await addButton.click();
      await page.waitForTimeout(300);
    }
  }
  await page.waitForTimeout(800);

  if (errors.length) {
    throw new Error(`the POS renderer threw during capture:\n  ${errors.join("\n  ")}`);
  }

  const out = path.join(process.cwd(), "public", posShotPath());
  await mkdir(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: "png" });
  console.log(`captured ${posShotPath()}`);

  await browser.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
