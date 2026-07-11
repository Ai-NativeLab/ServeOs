import { test, expect } from "@playwright/test";

// Requires the roma seed (npm run db:seed): one branch, hours 10:00–23:00
// daily, ≥1 published product, and roma.serveos.localhost → 127.0.0.1.

test("customer can schedule an order and cancel it while pending", async ({ page }) => {
  await page.goto("http://roma.serveos.localhost:3000/");

  // Add something to the cart via the product sheet.
  await page.getByRole("button", { name: /Configure/ }).first().click();
  await page.getByRole("button", { name: /Add —/ }).click();
  await page.getByRole("button", { name: /View cart/ }).click();
  await page.getByRole("link", { name: /Checkout/ }).click();

  // Switch to a scheduled time (first available slot pill, whichever day is shown).
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.getByTestId("slot").first().click();

  // Pickup avoids area/address requirements.
  await page.getByRole("button", { name: "Pickup" }).click();
  await page.getByPlaceholder("Name").fill("E2E Scheduler");
  await page.getByPlaceholder("Phone").fill("01000000000");
  await page.getByRole("button", { name: /Place order/ }).click();

  // Tracking page: scheduled banner + pending timeline + cancel. This is
  // typically the first navigation to /order/[token] in the whole e2e run,
  // so under parallel-worker load the dev server's on-demand compile of
  // that route can outrun the default 5s timeout — give it more room.
  await expect(page.getByText(/Scheduled for/)).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("pending", { exact: false })).toBeVisible();

  // The cancel control hydrates a moment after paint; under load the first
  // click can land before its handler attaches, so retry the click until
  // the confirmation dialog actually opens.
  const trigger = page.getByRole("button", { name: "Cancel order" });
  const dialog = page.getByRole("alertdialog");
  await expect(async () => {
    await trigger.click();
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });

  await dialog.getByRole("button", { name: "Cancel order" }).click(); // dialog action, scoped to avoid re-hitting the trigger
  await expect(page.getByText(/cancelled/i)).toBeVisible();
});
