import { test, expect } from "@playwright/test";
import { config as loadEnv } from "dotenv";
// Static imports only: Playwright resolves the "@/*" tsconfig path alias (and
// transpiles TS) for the module graph reachable via *static* import — a
// dynamic `await import("@/...")` inside a test body bypasses that transform
// entirely and fails at runtime ("Unexpected token 'export'"). None of these
// modules touch the DB at import time (src/db/client.ts connects lazily on
// first query), so importing them here is side-effect-free.
import { getTenantBySlug } from "@/server/tenancy";
import { listBranches } from "@/server/branches/service";
import { getPublishedMenu, getProduct } from "@/server/catalog/service";
import { upsertOfflineMethod } from "@/server/payments/offline/methods";

// Playwright runs as its own Node process (separate from the `npm run dev`
// webServer child process), so — unlike Next.js, which loads .env.local for
// us automatically — DATABASE_URL isn't set here unless we load it ourselves.
// Both processes point at the same local dev Postgres (:5433, db "serveos"),
// so a DB write made here is immediately visible to the running app.
loadEnv({ path: ".env.local" });

const ROOT = "http://localhost:3000";
const SLUG = "roma";
const METHOD_TYPE = "instapay";
const METHOD_LABEL = "InstaPay (e2e)";
const PAY_TO_DETAIL = "roma-e2e@instapay";
// Unique per run (not per-suite reset like the vitest DB): the dev DB
// accumulates orders across repeated `test:e2e` runs, and the payments-queue
// assertion below does a text lookup that must resolve to exactly one row.
const CUSTOMER_NAME = `E2E Offline Payer ${Date.now()}`;

let branchId = "";
let productId = "";

// Requires: `npm run db:seed` (tenant "roma", an active branch, published
// products). roma isn't seeded with an offline payment method enabled, so this
// setup enables one deterministically — via the exact same service
// (upsertOfflineMethod) the Settings → Payment methods UI (Task 3) calls —
// rather than weakening the assertions below to whatever happens to exist.
test.beforeAll(async () => {
  const tenant = await getTenantBySlug(SLUG);
  if (!tenant) throw new Error(`Tenant "${SLUG}" not found — run \`npm run db:seed\` first.`);

  const branches = await listBranches(tenant.id);
  if (branches.length === 0) throw new Error(`Tenant "${SLUG}" has no branch — run \`npm run db:seed\` first.`);
  branchId = branches[0].id;

  // Pick a product with no *required* modifier group — the API call below
  // sends no selectedOptionIds, and placeOrder rejects a line missing a
  // required selection (order_validation), same as a real checkout would.
  // The seeded roma catalog has plenty of both kinds; this walks the
  // published list to find one that needs no modifier decision.
  const menu = await getPublishedMenu(tenant.id, branchId);
  const candidates = menu.categories.flatMap((c) => c.products);
  if (candidates.length === 0) throw new Error(`Tenant "${SLUG}" has no published product — run \`npm run db:seed\` first.`);
  for (const candidate of candidates) {
    const full = await getProduct(tenant.id, candidate.id);
    if (full.modifierGroups.every((g) => !g.required)) {
      productId = candidate.id;
      break;
    }
  }
  if (!productId) throw new Error(`Tenant "${SLUG}" has no published product without a required modifier group.`);

  await upsertOfflineMethod(tenant.id, {
    type: METHOD_TYPE, label: METHOD_LABEL, payToDetail: PAY_TO_DETAIL, enabled: true,
  });
});

test("checkout shows the enabled offline method and its pay-to detail", async ({ page }) => {
  await page.goto("http://roma.serveos.localhost:3000/");
  await page.getByRole("button", { name: /Configure/ }).first().click();
  await expect(page.getByRole("button", { name: /Add —/ })).toBeVisible();
  await page.getByRole("button", { name: /Add —/ }).click();

  await page.getByRole("button", { name: /View cart/ }).click();
  await page.getByRole("link", { name: /Checkout/ }).click();
  await expect(page.getByRole("heading", { name: /Checkout/ })).toBeVisible();

  // The seeded offline method is a real option in the payment select, and
  // choosing it reveals the tenant's real pay-to detail + a reference field —
  // exactly what a customer needs to actually send the transfer.
  await page.locator("#co-payment").selectOption({ label: METHOD_LABEL });
  await expect(page.getByText(PAY_TO_DETAIL)).toBeVisible();
  await expect(page.getByPlaceholder("Transaction reference")).toBeVisible();
});

test("POST /api/orders with the offline method + reference creates a pending_verification order", async ({ request }) => {
  const res = await request.post(`${ROOT}/api/orders`, {
    data: {
      slug: SLUG,
      branchId,
      fulfillmentType: "pickup",
      customerName: CUSTOMER_NAME,
      customerPhone: "01000000000",
      paymentMethod: METHOD_TYPE,
      paymentReference: "E2E-REF-001",
      lines: [{ productId, quantity: 1, selectedOptionIds: [] }],
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(typeof body.statusToken).toBe("string");
  expect(body.statusToken.length).toBeGreaterThan(0);

  const statusRes = await request.get(`${ROOT}/api/orders/${body.statusToken}/status?slug=${SLUG}`);
  expect(statusRes.status()).toBe(200);
  const status = await statusRes.json();
  expect(status.paymentStatus).toBe("pending_verification");
});

test("the pending_verification order appears in the merchant's payments queue", async ({ page }) => {
  await page.goto("/login");
  await page.getByPlaceholder("e.g. roma").fill(SLUG);
  await page.locator('input[name="email"]').fill("owner@roma.com");
  await page.locator('input[name="password"]').fill("owner1234");
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/dashboard/payments");
  // Scope to the specific Card (data-slot="card") for this order rather than a
  // page-wide text search — filter(), not a text-then-walk-up locator, so this
  // can't accidentally resolve to more than one element in strict mode.
  const row = page.locator('[data-slot="card"]').filter({ hasText: CUSTOMER_NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText(METHOD_TYPE);
  await expect(row).toContainText("E2E-REF-001");
  await expect(row.getByRole("button", { name: "Confirm" })).toBeVisible();
});
