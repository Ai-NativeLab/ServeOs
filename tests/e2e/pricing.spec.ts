import { test, expect } from "@playwright/test";

// Requires: `npm run db:seed` (plans seeded, so the page has rows to render).

test("the pricing page serves Arabic right-to-left", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("/en/pricing serves English left-to-right", async ({ page }) => {
  await page.goto("/en/pricing");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("/ar/pricing redirects to the canonical path", async ({ page }) => {
  await page.goto("/ar/pricing");
  await expect(page).toHaveURL(/\/pricing$/);
});

test("the comparison table lists every limit and feature", async ({ page }) => {
  await page.goto("/en/pricing");
  for (const label of ["branches", "staff", "products", "orders / month", "WhatsApp ordering"]) {
    await expect(page.getByRole("rowheader", { name: label, exact: true })).toBeVisible();
  }
});

// PlanCard filters zero limits out of the cards because "0 WhatsApp numbers" is
// not a benefit. The table must not reintroduce it.
test("a zero limit reads as an em dash, never as zero", async ({ page }) => {
  await page.goto("/en/pricing");
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "WhatsApp numbers", exact: true }) });
  await expect(row.getByRole("cell").first()).toHaveText("—");
});

test("the home pricing section links through to the full comparison", async ({ page }) => {
  await page.goto("/en");
  await page.locator("#pricing").getByRole("link", { name: "Compare all plans" }).click();
  // The English page specifically: /pricing is the ARABIC URL, and a hardcoded
  // href sent English readers there.
  await expect(page).toHaveURL(/\/en\/pricing$/);
});

// Marketing chrome was written for the home page, where every nav target is an
// in-page anchor. On /pricing those sections do not exist, so the logo — the
// universal way back — pointed at nothing.
test("the pricing page's chrome links back to the home page, not to dead anchors", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.getByRole("banner").getByRole("link").first().click();
  // The home page, at its hero — not /en/pricing#hero, which is where a bare
  // "#hero" would have left the reader, on an anchor that does not exist there.
  await expect(page).toHaveURL(/\/en#hero$/);
});

// The switcher used to hardcode the home page, contradicting the hreflang
// alternates this very page declares.
test("switching language stays on the pricing page", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.getByRole("banner").getByRole("link", { name: "العربية" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
});

test("the free plan self-serves, carrying its key into registration", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.locator("#pricing").getByRole("link", { name: "Start free" }).first().click();
  await expect(page).toHaveURL(/\/register\?plan=basic/);
});

test("a paid plan asks a signed-out visitor to enquire", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.locator("#pricing").getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/subscribe\?plan=/);
  await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
});

/**
 * /subscribe sits outside the marketing locale allowlist, so no x-locale header
 * ever reaches it — the form read one anyway and rendered English for everyone,
 * including the default-locale reader this page is primarily written for.
 */
test("the enquiry form follows the language the visitor was reading", async ({ page }) => {
  await page.goto("/pricing");
  await page.locator("#pricing").getByRole("link", { name: "ابدأ الآن" }).first().click();
  await expect(page).toHaveURL(/lang=ar/);
  await expect(page.getByRole("button", { name: "ابعت الطلب" })).toBeVisible();
});

/**
 * Loaded directly, NOT followed from the pricing page.
 *
 * A soft navigation keeps the <html> element of the page it came from, so
 * asserting dir on a clicked-through form proves nothing about a cold load —
 * a shared link, a refresh, a search result. The root layout reads x-locale,
 * which reaches this path only because the proxy declares it from ?lang.
 */
test("a cold load of the enquiry form is a right-to-left Arabic document", async ({ page }) => {
  await page.goto("/subscribe?plan=pro&lang=ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("button", { name: "ابعت الطلب" })).toBeVisible();
});

test("a cold load in English is left-to-right", async ({ page }) => {
  await page.goto("/subscribe?plan=pro&lang=en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
});

// No ?lang at all — a hand-typed or truncated URL still gets the canonical
// locale, not the fallback the old header lookup produced.
test("the enquiry form defaults to Arabic without a lang parameter", async ({ page }) => {
  await page.goto("/subscribe?plan=pro");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("button", { name: "ابعت الطلب" })).toBeVisible();
});

// The design called for this and nothing exercised it: the action, the row and
// the provider call were only ever tested apart from the browser.
test("submitting the enquiry confirms it was received", async ({ page }) => {
  await page.goto("/en/pricing");
  await page.locator("#pricing").getByRole("link", { name: "Get started" }).first().click();

  await page.getByLabel("Name", { exact: true }).fill("Mona Adel");
  await page.getByLabel("Business name", { exact: true }).fill("El Nour Pharmacy");
  await page.getByLabel("Phone", { exact: true }).fill("+201001234567");
  await page.getByLabel("Email", { exact: true }).fill(`prospect-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(page.getByText("Got it. We'll be in touch shortly.")).toBeVisible();
});

test("an unknown plan key goes back to pricing rather than a dashboard", async ({ page }) => {
  await page.goto("/subscribe?plan=platinum");
  await expect(page).toHaveURL(/\/pricing$/);
});

/**
 * The reported defect.
 *
 * The marketing page hands out a real session through its demo door, and that
 * session used to satisfy "is signed in" — delivering prospects into the demo
 * tenant's billing page, showing El Salam Pharmacy's usage meters and a
 * Subscribe button that would have invoiced a tenant reset nightly.
 */
test("a demo visitor is never delivered into the demo tenant's billing page", async ({ page }) => {
  await page.goto("/api/demo/login?trade=pharmacy");
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/en/pricing");
  await page.locator("#pricing").getByRole("link", { name: "Get started" }).first().click();

  await expect(page.getByRole("button", { name: "Send request" })).toBeVisible();
  expect(page.url()).not.toContain("/dashboard/settings/billing");
});

// Guards the locale allowlist: the rewrite that makes /pricing work must never
// swallow the auth routes.
test("sign-in routes still work alongside the pricing rewrite", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator("form")).toBeVisible();
  await page.goto("/register");
  await expect(page.locator("form")).toBeVisible();
});
