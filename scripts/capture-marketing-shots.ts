import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import {
  DEVICE_VIEWPORT,
  SHOT_MATRIX,
  SURFACE_DEVICE,
  shotPath,
  type Shot,
} from "../src/app/(marketing)/_lib/shots";

/**
 * Captures the marketing page's app screenshots (storefront + dashboard, for
 * every trade) from the demo tenants seeded by scripts/seed-demo-tenants.ts.
 *
 *   npm run demo:seed                    # the tenants this signs into
 *   npm run dev                          # in one terminal — must already be running
 *   npm run marketing:shots -- --base-url http://localhost:3000
 *
 * RESTART `npm run dev` BEFORE RE-CAPTURING if the shots already exist. Next's
 * image optimizer caches by URL, and these files keep their URLs when their
 * contents change — a running dev server will happily serve the previous
 * capture at the same path, so the page shows the old screenshot and the new
 * PNG on disk looks ignored. The till shot has the same caveat.
 *
 * NO LOCALE: the app's UI chrome is English-only (shots.ts), so this captures
 * one set, not two. Re-run whenever a captured surface's design changes —
 * output is committed and a test (shots.test.ts) asserts every path exists.
 */
const args = process.argv.slice(2);
const baseUrl = args[args.indexOf("--base-url") + 1] ?? "http://localhost:3000";
const port = new URL(baseUrl).port || "3000";
const rootDomain = process.env.ROOT_DOMAIN ?? "serveos.localhost";
const password = process.env.DEMO_OWNER_PASSWORD ?? "demo1234";

/**
 * Where each surface lives, and what proves it has finished rendering.
 *
 * The storefront resolves by HOST, not by a query parameter — src/proxy.ts
 * classifies the subdomain and sets x-tenant-slug, and the storefront reads
 * that header server-side. Hitting localhost with ?tenant= would screenshot
 * the marketing page and label it "storefront".
 *
 * Both surfaces render into <main> (StorefrontShell and the dashboard layout),
 * which is the settled selector. There is no storefront test id in this repo.
 */
const SURFACE_ROUTE: Record<
  Shot["surface"],
  { url: (slug: string) => string; auth: boolean }
> = {
  storefront: { url: (slug) => `http://${slug}.${rootDomain}:${port}/`, auth: false },
  dashboard: { url: () => `${baseUrl}/dashboard`, auth: true },
};

async function signIn(page: Page, slug: string) {
  const email = `owner@${slug}.serveos.com`;
  await page.goto(`${baseUrl}/login`);
  await page.getByPlaceholder("e.g. roma").fill(slug);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  // Login submits via a server action (fetch-based), not a native form POST —
  // wait for the redirect to actually land before navigating again, or the
  // session cookie may not be set yet (see tests/e2e/dashboard.spec.ts).
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
}

/**
 * Next's dev-tools badge is a fixed-position overlay, so it lands in the
 * bottom-left of every capture — the black "N" circle sitting on top of the
 * storefront's first product card in the previously committed shots. It is
 * dev-only chrome that no customer ever sees, so it has no business in a
 * marketing screenshot. Hidden here rather than via `devIndicators: false` in
 * next.config, which would take it away from everyday development too.
 */
async function hideDevChrome(page: Page) {
  await page.addStyleTag({
    content: "nextjs-portal, [data-nextjs-dev-tools-button] { display: none !important; }",
  });
}

async function settle(page: Page) {
  await page.waitForSelector("main", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await hideDevChrome(page);
  // Let lazy images below the fold decode. `networkidle` returns once requests
  // stop, which on a page of next/image placeholders is before the real photos
  // have painted — capturing there yields grey boxes where the food should be.
  await page.waitForTimeout(1_200);
}

async function main() {
  const browser = await chromium.launch();
  const captured: string[] = [];

  for (const shot of SHOT_MATRIX) {
    const slug = `demo-${shot.trade}`;
    const route = SURFACE_ROUTE[shot.surface];
    // Each surface is captured on the device it is designed for — see
    // SURFACE_DEVICE in _lib/shots.ts, which the tour reads too so the frame
    // around the image always matches the viewport behind it.
    const device = SURFACE_DEVICE[shot.surface];
    const phone = device === "phone";
    const context = await browser.newContext({
      viewport: DEVICE_VIEWPORT[device],
      deviceScaleFactor: 2,
      isMobile: phone,
      hasTouch: phone,
    });
    const page = await context.newPage();

    // Signing in runs against the dashboard's desktop layout regardless of the
    // surface being captured; the login form is the same either way.
    if (route.auth) await signIn(page, slug);
    await page.goto(route.url(slug));
    await settle(page);

    const relPath = shotPath(shot.trade, shot.surface);
    const out = path.join(process.cwd(), "public", relPath);
    await mkdir(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, type: "png" });
    captured.push(relPath);
    console.log(`captured ${relPath}`);

    await context.close();
  }

  await browser.close();

  // A dated manifest beside the captures. The existence test (shots.test.ts)
  // catches a deleted file; nothing catches a stale one, so record when these
  // were taken and where they came from.
  const manifest = {
    capturedAt: new Date().toISOString(),
    baseUrl,
    rootDomain,
    shots: captured,
  };
  await writeFile(
    path.join(process.cwd(), "public", "marketing", "shots", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(`\n${captured.length} shots captured ✓`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
