import { test, expect } from "@playwright/test";

const ROOT = "http://localhost:3000";

test("GET /api/menu returns published products for an active tenant", async ({ request }) => {
  // Requires: tenant with slug "roma" exists with status active/trial
  // and has at least one published product
  const res = await request.get(`${ROOT}/api/menu?slug=roma`);
  expect(res.status()).toBe(200);
  const menu = await res.json();
  expect(menu).toHaveProperty("categories");
  expect(Array.isArray(menu.categories)).toBe(true);
});

test("GET /api/menu returns 404 for unknown slug", async ({ request }) => {
  const res = await request.get(`${ROOT}/api/menu?slug=doesnotexist`);
  expect(res.status()).toBe(404);
});

test("GET /api/menu returns 400 when slug is missing", async ({ request }) => {
  const res = await request.get(`${ROOT}/api/menu`);
  expect(res.status()).toBe(400);
});

test("storefront page renders menu for active tenant", async ({ request }) => {
  // Uses Host header injection (same pattern as onboarding E2E tests)
  const res = await request.get(ROOT, {
    headers: { host: "roma.serveos.localhost" },
  });
  expect(res.status()).toBe(200);
  const html = await res.text();
  // Should contain the tenant name (or "Menu coming soon" if no products yet)
  expect(html.toLowerCase()).toMatch(/pizza roma|coming soon|menu/i);
});
