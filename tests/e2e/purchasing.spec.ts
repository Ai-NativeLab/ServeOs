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

  test("full purchasing lifecycle: create supplier, draft PO, send, receive with lot cost, invoice variance, and close", async ({ page }) => {
    const timestamp = Date.now();
    const itemName = `Test Mozzarella ${timestamp}`;
    const supplierName = `Fresh Farms ${timestamp}`;

    // 1. Create an inventory item if not already existing
    await page.goto("/dashboard/inventory/items/new");
    await page.locator("#nameEn").fill(itemName);
    await page.locator('select[name="baseUom"]').selectOption("kg");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/dashboard\/inventory/);

    // 2. Create a supplier with email so PO can be sent
    await page.goto("/dashboard/suppliers");
    await page.getByPlaceholder("Acme Foods").fill(supplierName);
    await page.getByPlaceholder("supplier@acme.example").fill(`supplier.${timestamp}@test.example`);
    await page.getByRole("button", { name: "Add supplier" }).click();
    await expect(page.getByText(supplierName)).toBeVisible();

    // 3. Draft a purchase order: 10 @ 12.00 = 120.00
    await page.goto("/dashboard/purchase-orders/new");
    await page.locator("#supplierId").selectOption({ label: supplierName });
    
    // Fill line item: qty 10, unit cost 12
    const qtyInput = page.locator('table input[type="number"]').first();
    await qtyInput.fill("10");
    const costInput = page.locator('table input[type="number"]').nth(1);
    await costInput.fill("12");

    await expect(page.getByText("120.00 EGP")).toBeVisible();
    await page.getByRole("button", { name: "Save draft PO" }).click();

    // 4. Lands on PO detail page
    await expect(page).toHaveURL(/\/dashboard\/purchase-orders\/[0-9a-f-]+/);
    await expect(page.getByText("Draft")).toBeVisible();

    // 5. Send PO to supplier
    await page.getByRole("button", { name: "Send to supplier" }).click();
    await expect(page.getByText("Sent", { exact: true })).toBeVisible();

    // 6. Receive stock: 10 units
    await page.getByRole("button", { name: "Receive stock" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.locator('div[role="dialog"] button:has-text("Fill all remaining")').click();
    await page.locator('div[role="dialog"] button:has-text("Post receipt")').click();

    // 7. Verify status moves to Received and Variance Strip shows 120.00 received (not 0.00)
    await expect(page.getByText("Received", { exact: true })).toBeVisible();
    await expect(page.getByText("120.00 EGP").first()).toBeVisible();

    // 8. Enter Invoice: 132.00 (expect +12.00 delta)
    await page.getByRole("button", { name: "Enter invoice" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.locator('div[role="dialog"] input[type="number"]').fill("132");
    await page.locator('div[role="dialog"] button:has-text("Record invoice")').click();

    // 9. Verify variance strip renders the +12.00 invoiced variance delta
    await expect(page.getByText("+12.00 EGP")).toBeVisible();

    // 10. Close PO
    await page.getByRole("button", { name: "Close PO" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.locator('div[role="alertdialog"] button:has-text("Close PO")').click();

    // 11. Verify PO is closed
    await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  });
});
