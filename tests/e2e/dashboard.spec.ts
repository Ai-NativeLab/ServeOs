import { test, expect } from "@playwright/test";

// Requires: `npm run db:seed` (owner@roma.com / owner1234, slug roma).

test("owner can sign in and reach Orders", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();

  // Lands on the dashboard Home with the branded shell.
  // Scope to the sidebar <aside>: the topbar bell is also a link whose
  // accessible name ("Pending orders") substring-matches "Orders".
  await expect(page).toHaveURL(/\/dashboard/);
  const sidebarOrders = page.locator("aside").getByRole("link", { name: "Orders", exact: true });
  await expect(sidebarOrders).toBeVisible();

  await sidebarOrders.click();
  await expect(page.getByRole("heading", { name: "Orders" })).toBeVisible();
  // Either the table or the empty state renders — both are valid seeded states.
  await expect(page.getByRole("tab", { name: "All" })).toBeVisible();
});

test("owner sees every settings tab and lands on Business Profile", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();
  // Login submits via a server action (fetch-based), not a native form POST — wait for
  // the post-login redirect to actually land before navigating again, or the session
  // cookie may not be set yet when /dashboard/settings loads (see sibling test below too).
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard/settings");
  await expect(page).toHaveURL(/\/dashboard\/settings\/profile/);
  for (const label of ["Business Profile", "WhatsApp", "Fulfillment", "Staff", "Billing"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
});

test("staff cannot reach settings and is redirected to Orders", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("staff@roma.com");
  await page.locator('input[name="password"]').fill("staff1234");
  await page.locator('form button[type="submit"]').click();
  // See comment in the "owner" test above — wait for the post-login redirect first.
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard/settings");
  await expect(page).toHaveURL(/\/dashboard\/orders/);
});
