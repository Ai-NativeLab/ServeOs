import { test, expect } from "@playwright/test";

// Requires seeded DB: owner@roma.com / owner1234 (slug: roma)

test.describe("Purchasing & Suppliers Dashboard Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
    await page.getByPlaceholder("e.g. roma").fill("roma");
    await page.locator('input[name="email"]').fill("owner@roma.com");
    await page.locator('input[name="password"]').fill("owner1234");
    await page.locator('form button[type="submit"]').click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("owner sees Purchasing and Suppliers in nav", async ({ page }) => {
    const aside = page.locator("aside");
    const purchasingLink = aside.getByRole("link", { name: "Purchasing", exact: true });
    const suppliersLink = aside.getByRole("link", { name: "Suppliers", exact: true });

    await expect(purchasingLink).toBeVisible();
    await expect(suppliersLink).toBeVisible();
  });

  test("can navigate to purchase orders and view list", async ({ page }) => {
    await page.goto("/dashboard/purchase-orders");
    await expect(page.getByRole("heading", { name: "Purchase orders", exact: true })).toBeVisible();

    const draftBtn = page.getByRole("link", { name: "Draft PO", exact: true });
    const reorderBtn = page.getByRole("link", { name: "Reorder rules", exact: true });

    await expect(draftBtn).toBeVisible();
    await expect(reorderBtn).toBeVisible();
  });

  test("can navigate to suppliers and view catalog", async ({ page }) => {
    await page.goto("/dashboard/suppliers");
    await expect(page.getByRole("heading", { name: "Suppliers", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add supplier" })).toBeVisible();
  });

  test("can navigate to reorder rules and trigger check", async ({ page }) => {
    await page.goto("/dashboard/purchase-orders/reorder-rules");
    await expect(page.getByRole("heading", { name: "Reorder rules", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run check now" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add rule" })).toBeVisible();
  });

  test("can open new PO draft page with line builder", async ({ page }) => {
    await page.goto("/dashboard/purchase-orders/new");
    await expect(page.getByRole("heading", { name: "Draft purchase order", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add item" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft PO" })).toBeVisible();
  });
});
