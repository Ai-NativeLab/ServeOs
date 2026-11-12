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

  // Tap the first product card to open its detail sheet, then add it to the cart.
  await page.getByRole("button", { name: /Configure/ }).first().click();
  await expect(page.getByRole("button", { name: /Add —/ })).toBeVisible();
  await page.getByRole("button", { name: /Add —/ }).click();

  // The sticky cart bar appears once the cart is non-empty — open it.
  const cartBar = page.getByRole("button", { name: /View cart/ });
  await expect(cartBar).toBeVisible();
  await cartBar.click();

  // Checkout link appears inside the cart drawer
  const checkout = page.getByRole("link", { name: /Checkout/ });
  await expect(checkout).toBeVisible();
  await checkout.click();

  await expect(page.getByRole("heading", { name: /Checkout/ })).toBeVisible();
  await expect(page.getByPlaceholder("Name")).toBeVisible();
});

// #191 smart quick-add. "Garlic Bread" is a seeded roma starter with no
// modifier groups (simple); "Diavola" is a pizza with a required Size group.
test("simple products quick-add and step from the card; configurable ones open their sheet", async ({ page }) => {
  await page.goto("http://roma.serveos.localhost:3000/");
  const cartBar = page.getByRole("button", { name: /View cart/ });

  // Quick-add from the keyboard: Enter on the control must add, not open the sheet.
  const quickAdd = page.getByRole("button", { name: "Add Garlic Bread to cart" });
  await quickAdd.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cartBar).toHaveText(/1 item(?!s)/);

  // The stepper replaces the add button and takes focus.
  const increase = page.getByRole("button", { name: "Increase quantity of Garlic Bread" });
  await expect(increase).toBeFocused();
  await increase.click();
  await expect(cartBar).toHaveText(/2 items/);
  await expect(page.getByRole("status").filter({ hasText: "Garlic Bread: 2 in cart" })).toHaveCount(1);

  // Down to zero removes the line and brings the add button back.
  const decrease = page.getByRole("button", { name: "Decrease quantity of Garlic Bread" });
  await decrease.click();
  await expect(cartBar).toHaveText(/1 item(?!s)/);
  await decrease.click();
  await expect(cartBar).toBeHidden();
  await expect(quickAdd).toBeVisible();

  // A product with required options still opens its sheet.
  await page.getByRole("button", { name: "Select options for Diavola" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: /Add —/ })).toBeVisible();
});
