import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { SHOT_MATRIX, shotPath, type Shot } from "../src/app/(marketing)/_lib/shots";

/**
 * Captures the marketing page's app screenshots (storefront + dashboard, for
 * every trade) from the demo tenants seeded by scripts/seed-demo-tenants.ts.
 *
 *   npm run dev                          # in one terminal — must already be running
 *   npx tsx scripts/capture-marketing-shots.ts --base-url http://localhost:3000
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

async function settle(page: Page) {
  await page.waitForSelector("main", { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
}

async function main() {
  const browser = await chromium.launch();
  const captured: string[] = [];

  for (const shot of SHOT_MATRIX) {
    const slug = `demo-${shot.trade}`;
    const route = SURFACE_ROUTE[shot.surface];
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

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
