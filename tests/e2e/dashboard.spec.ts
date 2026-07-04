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
