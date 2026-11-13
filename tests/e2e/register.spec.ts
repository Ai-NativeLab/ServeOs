import { test, expect, type Page } from "@playwright/test";

// Requires: `npm run db:seed` (plans seeded, and the `roma` tenant exists).
//
// Every rejected input used to throw out of registerAction, which Next turns
// into "This page couldn't load" with an error digest and a wiped form (#204).

const run = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function fillRegister(page: Page, f: { slug: string; email: string; password?: string }) {
  await page.goto("/register");
  await page.getByLabel("Restaurant name").fill("E2E Kitchen");
  await page.getByLabel("Subdomain").fill(f.slug);
  await page.getByLabel("Your name").fill("E2E Owner");
  await page.getByLabel("Email").fill(f.email);
  await page.getByLabel("Password").fill(f.password ?? "correcthorse1");
}

test("a subdomain typed with capitals registers lowercased and lands on the dashboard", async ({ page }) => {
  const id = run();
  await fillRegister(page, { slug: `E2E-${id}`, email: `owner-${id}@example.com` });
  await expect(page.getByText(`e2e-${id}.`)).toBeVisible();
  await page.getByRole("button", { name: "Start free trial" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("a taken subdomain keeps the form and says so instead of crashing", async ({ page }) => {
  const id = run();
  // `Roma` normalises to the seeded `roma` tenant's subdomain.
  await fillRegister(page, { slug: "Roma", email: `taken-${id}@example.com` });
  await page.getByRole("button", { name: "Start free trial" }).click();
  await expect(page.getByText("That subdomain is taken")).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByLabel("Email")).toHaveValue(`taken-${id}@example.com`);
});

test("the server rejects a short password even when browser validation is bypassed", async ({ page }) => {
  const id = run();
  await fillRegister(page, { slug: `short-${id}`, email: `short-${id}@example.com`, password: "abc" });
  await page.locator("form").evaluate((f) => ((f as HTMLFormElement).noValidate = true));
  await page.getByRole("button", { name: "Start free trial" }).click();
  await expect(page.getByText("Use at least 8 characters.")).toBeVisible();
  await expect(page.getByLabel("Subdomain")).toHaveValue(`short-${id}`);
});
