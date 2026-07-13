import { test, expect } from "@playwright/test";

test("marketing homepage renders hero, features, and auth links", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");

  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
  await expect(page.getByRole("link", { name: "Get Started" }).first()).toHaveAttribute("href", "/register");

  await expect(
    page.getByRole("heading", { name: "Everything you need behind the counter." }),
  ).toBeVisible();

  // Restaurant is the default trade.
  await expect(page.getByText("QR Menu & Ordering")).toBeVisible();
  await expect(page.getByText("Live Analytics")).toBeVisible();
});

test("switching trade re-skins the hero, docket, and features", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("tab", { name: "Restaurant" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No restaurant website?");
  await expect(page.getByTestId("ticket")).toContainText("Table 4");

  await page.getByRole("tab", { name: "Timber", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("No timber yard website?");
  // The shared promise is deliberately identical across every trade.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");
  await expect(page.getByTestId("ticket")).toContainText("Oak plank");
  await expect(page.getByTestId("ticket")).toContainText("0.026 m³");
  await expect(page.getByRole("heading", { name: "Sold by Dimension" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "QR Menu & Ordering" })).toBeHidden();
});

test("the docket keeps one height across every trade", async ({ page }) => {
  await page.goto("/");
  const ticket = page.getByTestId("ticket");

  const heights: number[] = [];
  for (const trade of ["Restaurant", "Retail", "Pharmacy", "Timber"]) {
    await page.getByRole("tab", { name: trade, exact: true }).click();
    await expect(ticket).toBeVisible();
    const box = await ticket.boundingBox();
    heights.push(Math.round(box!.height));
  }

  expect(new Set(heights).size).toBe(1);
});

test("features the product does not ship yet are marked, not sold", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Pharmacy", exact: true }).click();

  // Batch/expiry has no schema in src/server — it must not read as shipped.
  const batch = page.locator("div").filter({ hasText: /^Batch & Expiry/ }).first();
  await expect(batch).toContainText("Soon");
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
