import { test, expect } from "@playwright/test";

// Requires: `npm run db:seed` (plans seeded, so the page has rows to render).

test("the pricing page serves Arabic right-to-left", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("/en/pricing serves English left-to-right", async ({ page }) => {
  await page.goto("/en/pricing");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("/ar/pricing redirects to the canonical path", async ({ page }) => {
  await page.goto("/ar/pricing");
  await expect(page).toHaveURL(/\/pricing$/);
});

test("the comparison table lists every limit and feature", async ({ page }) => {
  await page.goto("/en/pricing");
  for (const label of ["branches", "staff", "products", "orders / month", "WhatsApp ordering"]) {
    await expect(page.getByRole("rowheader", { name: label, exact: true })).toBeVisible();
  }
});

// PlanCard filters zero limits out of the cards because "0 WhatsApp numbers" is
// not a benefit. The table must not reintroduce it.
test("a zero limit reads as an em dash, never as zero", async ({ page }) => {
  await page.goto("/en/pricing");
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "WhatsApp numbers", exact: true }) });
  await expect(row.getByRole("cell").first()).toHaveText("—");
});

test("the home pricing section links through to the full comparison", async ({ page }) => {
  await page.goto("/en");
  await page.locator("#pricing").getByRole("link", { name: "Compare all plans" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
});

test("the free plan self-serves, carrying its key into registration", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.locator("#pricing").getByRole("link", { name: "Start free" }).first().click();
  await expect(page).toHaveURL(/\/register\?plan=basic/);
});

test("a paid plan asks a signed-out visitor to enquire", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.locator("#pricing").getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/subscribe\?plan=/);
  await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
});

test("an unknown plan key goes back to pricing rather than a dashboard", async ({ page }) => {
  await page.goto("/subscribe?plan=platinum");
  await expect(page).toHaveURL(/\/pricing$/);
});

/**
 * The reported defect.
 *
 * The marketing page hands out a real session through its demo door, and that
 * session used to satisfy "is signed in" — delivering prospects into the demo
 * tenant's billing page, showing El Salam Pharmacy's usage meters and a
 * Subscribe button that would have invoiced a tenant reset nightly.
 */
test("a demo visitor is never delivered into the demo tenant's billing page", async ({ page }) => {
  await page.goto("/api/demo/login?trade=pharmacy");
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/en/pricing");
  await page.locator("#pricing").getByRole("link", { name: "Get started" }).first().click();

  await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
  expect(page.url()).not.toContain("/dashboard/settings/billing");
});

// Guards the locale allowlist: the rewrite that makes /pricing work must never
// swallow the auth routes.
test("sign-in routes still work alongside the pricing rewrite", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("form")).toBeVisible();
  await page.goto("/register");
  await expect(page.locator("form")).toBeVisible();
});
