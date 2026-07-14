import { test, expect } from "@playwright/test";

const ROOT = "http://localhost:3000";

// Requires: npx tsx scripts/seed-retail-showcase.ts (tenant "nobio", vertical retail)

test("retail storefront renders the shop template", async ({ request }) => {
  const res = await request.get(ROOT, { headers: { host: "nobio.serveos.localhost" } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain("Nobio Hardware");
  expect(html).toContain("Soft-Close Hinge");
  expect(html).toMatch(/search products/i); // shop search bar (menu template has none)
  expect(html).toMatch(/out of stock/i); // seeded out-of-stock product visible but flagged
});

test("restaurant storefront still renders the menu template (no search bar)", async ({ request }) => {
  const res = await request.get(ROOT, { headers: { host: "roma.serveos.localhost" } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).not.toMatch(/search products/i);
});
