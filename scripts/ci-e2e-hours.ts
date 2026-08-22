import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true });

/**
 * CI-only companion to db:seed. Widens every roma branch to 24/7 so
 * immediate-order e2e flows can't fail when the runner's clock is outside
 * the seeded 10:00–23:00 window. open === close means "open 24h"
 * (src/server/branches/orderability.ts).
 *
 *   ENV_FILE=.env.test npx tsx scripts/ci-e2e-hours.ts
 */
async function main() {
  const { pool } = await import("../src/db/client");
  const { getTenantBySlug } = await import("../src/server/tenancy");
  const { listBranches, updateBranchOrdering } = await import(
    "../src/server/branches/service"
  );

  const tenant = await getTenantBySlug("roma");
  if (!tenant) throw new Error("roma tenant not found — run db:seed first");
  const branches = await listBranches(tenant.id);
  if (branches.length === 0) throw new Error("roma has no branches — run db:seed first");

  for (const branch of branches) {
    await updateBranchOrdering(tenant.id, branch.id, {
      acceptingOrders: true,
      openingHours: Array.from({ length: 7 }, (_, day) => ({
        day,
        open: "00:00",
        close: "00:00",
        closed: false,
      })),
    });
  }
  console.log(`Widened ${branches.length} roma branch(es) to 24/7`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
