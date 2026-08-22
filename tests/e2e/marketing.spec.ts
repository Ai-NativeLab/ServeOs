import { test, expect } from "@playwright/test";

// Requires: `npm run db:seed` (plans seeded, so the pricing section has rows).

test("the homepage is Arabic and right-to-left in the served HTML", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("أنشئ موقعك في دقيقة واحدة.");
});

test("Arabic ships without JavaScript, which is what proves there is no flash", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("أنشئ موقعك في دقيقة واحدة.");
  await context.close();
});

test("/en serves English left-to-right", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");
});

test("/ar redirects to the canonical root", async ({ page }) => {
  await page.goto("/ar");
  await expect(page).toHaveURL(/\/$/);
});

test("switching trade re-copies the hero and the docket", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByRole("tab", { name: "Restaurant" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No restaurant website?");
  await expect(page.getByTestId("ticket")).toContainText("Table 4");

  await page.getByRole("tab", { name: "Timber", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("No timber yard website?");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Create your own in 1 minute.");
  await expect(page.getByTestId("ticket")).toContainText("Oak plank");
});

/**
 * The pinned tour is rebuilt whenever the trade changes. useGSAP defers its
 * cleanup to unmount unless `revertOnUpdate` is set, so each switch used to add
 * another pinned ScrollTrigger to #surfaces without reverting the last: one pin
 * after load, four after three switches. ScrollTrigger drops pin spacing when
 * an element is pinned twice, which took ~2700px out of the document, and Lenis
 * kept a scroll limit measured against that collapsed page. The reader was then
 * clamped part-way down and yanked backwards on every wheel event — everything
 * below the tour, pricing and the footer included, was unreachable.
 *
 * Asserted through the wheel rather than window.scrollTo because that is the
 * path Lenis intercepts; a programmatic scroll still reached the bottom while
 * the bug was present, so it would not have caught this.
 */
async function wheelToBottom(page: import("@playwright/test").Page): Promise<boolean> {
  const atBottom = () =>
    window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
  for (let i = 0; i < 300; i++) {
    if (await page.evaluate(atBottom)) return true;
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(40);
  }
  return page.evaluate(atBottom);
}

test("the page is still scrollable to the bottom after switching trade", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No restaurant website?");

  for (const trade of ["Retail", "Pharmacy", "Timber"]) {
    await page.getByRole("tab", { name: trade, exact: true }).click();
    await expect(page.getByRole("tab", { name: trade, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  }
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No timber yard website?");

  expect(await wheelToBottom(page)).toBe(true);
  await expect(page.locator("footer")).toBeInViewport();
});

test("the docket keeps one height across every trade", async ({ page }) => {
  await page.goto("/en");
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
  await page.goto("/en");
  await page.getByRole("tab", { name: "Pharmacy", exact: true }).click();

  // Generic Substitutes has no implementation anywhere in src/server, so it
  // must carry the chip. Batch & Expiry deliberately does NOT — it has schema
  // (lotCode/expiryAt) and dashboard UI, so chipping it would under-sell a
  // feature that ships. Both halves matter: this test fails if we advertise
  // vapour, and equally if we hide something real.
  const unshipped = page.locator("h3").filter({ hasText: /Generic Substitutes/ }).first();
  await expect(unshipped).toContainText("Soon");

  const shipped = page.locator("h3").filter({ hasText: /Batch & Expiry/ }).first();
  await expect(shipped).not.toContainText("Soon");
});

test("the demo band offers two doors for every trade", async ({ page }) => {
  await page.goto("/en");
  const demo = page.locator("#demo");
  await expect(demo.getByRole("link", { name: "Open the storefront" })).toHaveCount(4);
  await expect(demo.getByRole("link", { name: "Open the dashboard" })).toHaveCount(4);
  await expect(demo.getByRole("link", { name: "Open the dashboard" }).first())
    .toHaveAttribute("href", "/api/demo/login?trade=restaurant");
});

test("pricing renders plans and the term switcher changes the figure", async ({ page }) => {
  await page.goto("/en");
  const pricing = page.locator("#pricing");
  await expect(pricing.getByRole("tab", { name: /Quarterly/ })).toHaveAttribute("aria-selected", "true");

  const firstPaid = pricing.locator("h3").filter({ hasText: /Pro/ }).first();
  await expect(firstPaid).toBeVisible();

  const before = await pricing.innerText();
  await pricing.getByRole("tab", { name: /Annual/ }).click();
  await expect(pricing.getByRole("tab", { name: /Annual/ })).toHaveAttribute("aria-selected", "true");
  expect(await pricing.innerText()).not.toBe(before);
});

test("outcomes are labelled as illustrative rather than attributed", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("#outcomes")).toContainText("Illustrative");
});

test("the footer carries every navigation column", async ({ page }) => {
  await page.goto("/en");
  const footer = page.locator("footer");
  for (const heading of ["Platform", "Trades", "Pricing", "Company"]) {
    await expect(footer.getByRole("navigation", { name: heading })).toBeVisible();
  }
  await expect(footer).toContainText("Priced in EGP");
});
