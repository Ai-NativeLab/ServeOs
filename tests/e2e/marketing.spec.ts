import { test, expect } from "@playwright/test";

test("marketing homepage renders hero, features, and auth links", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your menu, online.");

  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Get Started" }).first()).toHaveAttribute("href", "/register");

  await expect(
    page.getByRole("heading", { name: "Everything your restaurant needs to take orders online." }),
  ).toBeVisible();
  await expect(page.getByText("QR Menu & Ordering")).toBeVisible();
  await expect(page.getByText("Live Analytics")).toBeVisible();
});
