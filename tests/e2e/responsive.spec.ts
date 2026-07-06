import { test, expect } from "@playwright/test";

const MOBILE = { width: 375, height: 800 };

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe("mobile dashboard navigation", () => {
  test.use({ viewport: MOBILE });

  test("hamburger opens a drawer that navigates and closes", async ({ page }) => {
    await login(page);

    // Desktop sidebar is hidden on mobile.
    await expect(page.locator("aside")).toBeHidden();

    // Open the drawer from the top bar.
    await page.getByRole("button", { name: "Open menu" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    // Navigate to Orders from inside the drawer.
    await drawer.getByRole("link", { name: "Orders", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/orders/);
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();

    // Drawer auto-closes after navigation.
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("menu shows product cards, not a wide table, on mobile", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard/menu");
    await expect(page.getByRole("heading", { name: "Menu" })).toBeVisible();

    // No horizontal overflow of the page body at 375px.
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(375 + 1);

    // The product table is hidden on mobile (its wrapper is `hidden md:block`).
    await expect(page.locator("table").first()).toBeHidden();
  });

  test("orders shows cards, not a wide table, on mobile", async ({ page }) => {
    await login(page);
    await page.goto("/dashboard/orders");
    await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();

    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(375 + 1);

    // On mobile the table wrapper is `hidden md:block`; with seeded orders the
    // card list renders instead. When there are zero orders the EmptyState shows
    // and there is simply no <table> — both satisfy "table not visible".
    await expect(page.locator("table")).toBeHidden();
  });
});

test.describe("no horizontal overflow at 360px", () => {
  test.use({ viewport: { width: 360, height: 780 } });

  async function assertNoHScroll(page: import("@playwright/test").Page, url: string) {
    await page.goto(url);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${url}`).toBeLessThanOrEqual(1);
  }

  test("public pages do not overflow", async ({ page }) => {
    await assertNoHScroll(page, "/");        // marketing
    await assertNoHScroll(page, "/login");
    await assertNoHScroll(page, "/register");
  });

  test("dashboard pages do not overflow", async ({ page }) => {
    await login(page);
    for (const url of ["/dashboard", "/dashboard/menu", "/dashboard/orders", "/dashboard/analytics", "/dashboard/settings"]) {
      await assertNoHScroll(page, url);
    }
  });
});
