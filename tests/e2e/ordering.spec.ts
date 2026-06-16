import { test, expect } from "@playwright/test";

// Uses the roma.serveos.localhost subdomain approach established in the project.
// Requires: roma tenant seeded with a branch (acceptingOrders=true) and
// at least one published product. Run `npm run db:seed` first.
//
// Full browser navigation requires roma.serveos.localhost to resolve to 127.0.0.1
// (add to /etc/hosts if needed). Also requires `allowedDevOrigins` in next.config.ts.

test("customer can browse, add to cart, and reach checkout", async ({ page }) => {
  await page.goto("http://roma.serveos.localhost:3000/");
  await expect(page.getByRole("heading", { name: /Pizza Roma|Roma/ })).toBeVisible();

  // Add the first available product to the cart
  const addButton = page.getByRole("button", { name: "Add" }).first();
  await addButton.click();

  // Open the cart drawer — button is fixed-position, may need force to bypass overlapping elements
  const cartButton = page.locator("button").filter({ hasText: /🛒/ });
  await cartButton.click({ force: true });

  // Checkout link appears inside the cart drawer
  const checkout = page.getByRole("link", { name: /Checkout/ });
  await expect(checkout).toBeVisible();
  await checkout.click();

  await expect(page.getByRole("heading", { name: /Checkout/ })).toBeVisible();
  await expect(page.getByPlaceholder("Name")).toBeVisible();
});
