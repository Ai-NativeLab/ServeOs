import { test, expect } from "@playwright/test";

test("marketing homepage renders hero, features, and auth links", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");

  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Get Started" }).first()).toHaveAttribute("href", "/register");

  await expect(
    page.getByRole("heading", { name: "Everything your restaurant needs to take orders online." }),
  ).toBeVisible();
  await expect(page.getByText("QR Menu & Ordering")).toBeVisible();
  await expect(page.getByText("Live Analytics")).toBeVisible();
});

test("language toggle switches the homepage to Arabic and sets RTL", async ({ page }) => {
  await page.goto("/");

  // Defaults to English.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  // Toggle to Arabic (the button is labelled "العربية" while in English).
  await page.getByRole("button", { name: "التبديل إلى العربية" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("أنشئ موقعك في دقيقة واحدة.");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");

  // Preference persists across a reload.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("أنشئ موقعك في دقيقة واحدة.");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});
