import { config } from "dotenv";
config({ path: process.env.ENV_FILE ?? ".env.local", override: true, quiet: true });

/**
 * Seeds ONLY the subscription plans.
 *
 *   ENV_FILE=.env.qa npx tsx scripts/seed-plans.ts
 *
 * Exists because scripts/seed.ts deletes the roma tenant's products and
 * categories before rebuilding them — safe on a laptop, destructive against a
 * shared environment where someone may be mid-test. This touches nothing but
 * the `plans` table, and `seedDefaultPlans` upserts on `key`, so re-running is
 * idempotent and no subscription is ever detached from its plan.
 */
async function main() {
  const { seedDefaultPlans, DEFAULT_PLANS } = await import("../src/server/subscription/plans.seed");
  const { db } = await import("../src/db/client");
  const { plans } = await import("../src/server/subscription/schema");

  const before = await db.select().from(plans);
  console.log(`before: ${before.length} plan(s) — ${before.map((p) => `${p.key}@${p.priceMonthly}`).join(", ") || "none"}`);

  await seedDefaultPlans();

  const after = await db.select().from(plans);
  console.log(`after:  ${after.length} plan(s)`);
  for (const p of after.sort((a, b) => Number(a.priceMonthly) - Number(b.priceMonthly))) {
    console.log(`  ${p.key.padEnd(12)} ${p.name.padEnd(14)} ${p.priceMonthly} ${p.currency}`);
  }

  const expected = DEFAULT_PLANS.length;
  if (after.length !== expected) {
    console.warn(`\n! ${after.length} plans present but ${expected} are defined — an extra row is likely an old key that no longer seeds. The pricing page renders every active plan, so check before leaving it.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
