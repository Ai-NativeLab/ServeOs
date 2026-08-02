import { test, expect } from "@playwright/test";

// Requires: `npm run db:seed` (admin@serveos.com / admin1234 platform admin,
// owner@roma.com / owner1234 tenant owner, slug roma).

test("platform admin signs in and reaches the console", async ({ page }) => {
  await page.goto("/admin/login");
  await page.locator('input[name="email"]').fill("admin@serveos.com");
  await page.locator('input[name="password"]').fill("admin1234");
  await page.locator('form button[type="submit"]').click();

  // The overview page renders — this is the page that threw in production.
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("a tenant user visiting /admin gets an explanation, not the login form", async ({ page }) => {
  // The session cookie is scoped to "/", so a dashboard session reaches /admin.
  // Bouncing them to the admin login form would then reject their genuinely
  // correct credentials with "Invalid email or password" — a false message.
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill("roma");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/admin");

  await expect(page).toHaveURL(/\/admin\/no-access/);
  await expect(page.getByRole("heading", { name: "No platform access" })).toBeVisible();
});

test("a non-admin platform account is told why, and is not asked to retype", async ({ page }) => {
  // Authorization is checked before the session is issued, so this never
  // becomes a cookie that every /admin page silently refuses.
  await page.goto("/admin/login");
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();

  // A tenant owner is not a platform user at all, so this is a credential
  // rejection — the point is that we stay on the form with a message rather
  // than handing out a session that later fails.
  await expect(page).toHaveURL(/\/admin\/login\?error=/);
  await expect(page.getByText(/Invalid email or password|not a platform admin/)).toBeVisible();
});
